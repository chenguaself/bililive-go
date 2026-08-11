package stages

import (
	"bytes"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"text/template"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/pipeline"
	"github.com/bililive-go/bililive-go/src/pkg/openlist"
	"github.com/bililive-go/bililive-go/src/tools"
)

// ExtractCoverStage 封面提取阶段
type ExtractCoverStage struct {
	config   pipeline.StageConfig
	commands []string
	logs     string
}

// NewExtractCoverStage 创建封面提取阶段工厂
func NewExtractCoverStage(config pipeline.StageConfig) (pipeline.Stage, error) {
	return &ExtractCoverStage{
		config: config,
	}, nil
}

func (s *ExtractCoverStage) Name() string {
	return pipeline.StageNameExtractCover
}

func (s *ExtractCoverStage) Execute(ctx *pipeline.PipelineContext, input []pipeline.FileInfo) ([]pipeline.FileInfo, error) {
	if len(input) == 0 {
		s.logs = "没有输入文件"
		return input, nil
	}

	var output []pipeline.FileInfo

	// 先添加所有输入文件到输出
	output = append(output, input...)

	// 对每个视频文件提取封面
	for _, file := range input {
		// 只处理视频文件
		if file.Type != pipeline.FileTypeVideo {
			continue
		}

		// 跳过已标记待删除的文件（如 ConvertMp4 阶段标记的原始 FLV），
		// 避免重复提取封面。
		if file.Deletable {
			continue
		}

		// 检查文件是否存在
		if _, err := os.Stat(file.Path); os.IsNotExist(err) {
			s.logs += fmt.Sprintf("文件不存在: %s\n", file.Path)
			continue
		}

		ctx.Logger.Infof("提取封面: %s", file.Path)

		// 提取封面
		coverPath, err := tools.ExtractCover(ctx.Ctx, file.Path)
		if err != nil {
			s.logs += fmt.Sprintf("提取封面失败: %s - %s\n", filepath.Base(file.Path), err.Error())
			ctx.Logger.Warnf("提取封面失败: %s - %s", file.Path, err)
			continue
		}

		// 添加封面文件到输出
		output = append(output, pipeline.FileInfo{
			Path:       coverPath,
			Type:       pipeline.FileTypeCover,
			SourcePath: file.Path,
		})

		s.logs += fmt.Sprintf("封面已保存: %s\n", filepath.Base(coverPath))
		ctx.Logger.Infof("封面已保存: %s", coverPath)
	}

	return output, nil
}

func (s *ExtractCoverStage) GetCommands() []string {
	return s.commands
}

func (s *ExtractCoverStage) GetLogs() string {
	return s.logs
}

// CloudUploadStage 云上传阶段
type CloudUploadStage struct {
	config         pipeline.StageConfig
	storageName    string
	pathTemplate   string
	deleteAfter    bool   // 仅删除已上传的文件
	deleteAllAfter bool   // 删除全部文件（含中间产物）
	uploadTiming   string // immediate 或 after_process
	fileTypes      []string // 过滤的文件类型，空表示所有
	commands       []string
	logs           string
}

// NewCloudUploadStage 创建云上传阶段工厂
func NewCloudUploadStage(config pipeline.StageConfig) (pipeline.Stage, error) {
	return &CloudUploadStage{
		config:         config,
		storageName:    config.GetStringOption(pipeline.OptionStorage, ""),
		pathTemplate:   config.GetStringOption(pipeline.OptionPathTemplate, ""),
		deleteAfter:    config.GetBoolOption(pipeline.OptionDeleteAfter, false),
		deleteAllAfter: config.GetBoolOption(pipeline.OptionDeleteAllAfter, false),
		uploadTiming:   config.GetStringOption(pipeline.OptionUploadTiming, ""),
		fileTypes:      config.GetStringSliceOption(pipeline.OptionFileTypes),
	}, nil
}

func (s *CloudUploadStage) Name() string {
	return pipeline.StageNameCloudUpload
}

func (s *CloudUploadStage) Execute(ctx *pipeline.PipelineContext, input []pipeline.FileInfo) ([]pipeline.FileInfo, error) {
	if len(input) == 0 {
		s.logs = "没有输入文件"
		return input, nil
	}

	if s.storageName == "" {
		s.logs = "未配置存储名称，跳过上传"
		return input, nil
	}

	// 获取 OpenList 管理器
	mgr := openlist.GetGlobalManager()
	if mgr == nil {
		s.logs = "OpenList 管理器未初始化\n"
		return input, fmt.Errorf("OpenList 管理器未初始化")
	}

	// 获取配置并创建客户端
	config := configs.GetCurrentConfig()
	if config == nil {
		s.logs = "配置未初始化\n"
		return input, fmt.Errorf("配置未初始化")
	}

	client, err := mgr.GetClient(ctx.Ctx, config.OpenList.Token, config.OpenList.Username, config.OpenList.Password)
	if err != nil {
		s.logs += fmt.Sprintf("创建 OpenList 客户端失败: %s\n", err.Error())
		return input, fmt.Errorf("创建 OpenList 客户端失败: %w", err)
	}

	// 如果 token 变化了（通过用户名密码登录获取了新 token），自动写回配置
	if newToken := client.GetCurrentToken(); newToken != "" && newToken != config.OpenList.Token {
		_, err := configs.UpdateWithRetry(func(c *configs.Config) error {
			c.OpenList.Token = newToken
			return nil
		}, 3, 10*time.Millisecond)
		if err != nil {
			ctx.Logger.Warnf("保存 OpenList token 到配置文件失败: %v", err)
		} else {
			ctx.Logger.Info("OpenList token 已自动更新到配置文件")
		}
	}

	var output []pipeline.FileInfo
	var uploadFailed bool
	usedPaths := map[string]bool{} // 检测远程路径冲突

	// 上传所有非 Deletable 的视频文件和封面文件
	// Deletable 检查已能正确区分中间产物（如 ConvertMp4 标记的原始 FLV）
	// 与最终视频（如录播姬生成的多分段 _PART 文件），无需额外限制
	uploadedIndices := map[int]bool{} // 记录实际上传的文件在 output 中的索引

	for _, file := range input {
		// 跳过标记为待删除的中间文件（由其他阶段产出，不应上传）
		if file.Deletable {
			output = append(output, file)
			continue
		}

		// 文件类型过滤
		if len(s.fileTypes) > 0 && !s.matchFileType(file.Type) {
			output = append(output, file)
			continue
		}

		// 检查文件是否存在
		if _, err := os.Stat(file.Path); os.IsNotExist(err) {
			s.logs += fmt.Sprintf("文件不存在: %s\n", file.Path)
			output = append(output, file)
			uploadFailed = true
			continue
		}

		// 渲染目标路径
		targetPath := s.renderTargetPath(ctx, file)
		if targetPath == "" {
			s.logs += fmt.Sprintf("无法生成目标路径: %s\n", file.Path)
			output = append(output, file)
			uploadFailed = true
			continue
		}

		// 检测远程路径冲突（多分段视频或视频+封面使用相同模板时可能产生同路径）
		// 冲突时自动追加原始文件名以区分
		if usedPaths[targetPath] {
			// 使用 path.* 而非 filepath.*，因为 targetPath 是远程路径，始终用正斜杠
			dir := path.Dir(targetPath)
			ext := filepath.Ext(targetPath)
			base := strings.TrimSuffix(path.Base(targetPath), ext)
			targetPath = path.Join(dir, base+"_"+filepath.Base(file.Path))
			ctx.Logger.Infof("检测到远程路径冲突，自动追加文件名: %s", targetPath)
		}
		usedPaths[targetPath] = true

		ctx.Logger.Infof("上传文件: %s -> %s", file.Path, targetPath)
		s.commands = append(s.commands, fmt.Sprintf("upload %s to %s/%s", file.Path, s.storageName, targetPath))

		// 构建完整的远程路径（storage + targetPath）
		// OpenList API 的 File-Path 需要包含存储路径
		remotePath := targetPath
		if !strings.HasPrefix(remotePath, "/") {
			remotePath = "/" + remotePath
		}
		// 确保存储名和路径之间没有双斜杠
		fullRemotePath := "/" + s.storageName + remotePath

		// 确保远程目录存在（递归创建）
		// 使用 path.Dir 而非 filepath.Dir，因为远程路径始终用正斜杠
		remoteDir := path.Dir(fullRemotePath)
		if remoteDir != "" && remoteDir != "." {
			if err := client.MkdirRecursive(ctx.Ctx, remoteDir); err != nil {
				ctx.Logger.Warnf("创建远程目录失败（可能已存在）: %s - %v", remoteDir, err)
			}
		}

		// 执行上传（带进度追踪）
		fileName := filepath.Base(file.Path)
		ctx.Logger.Infof("开始上传: %s -> %s/%s", fileName, s.storageName, targetPath)
		err := client.Upload(ctx.Ctx, file.Path, fullRemotePath, func(p openlist.UploadProgress) {
			// 进度回调仅用于内部追踪，不打印日志
		})

		if err != nil {
			s.logs += fmt.Sprintf("上传失败: %s -> %s/%s - %s\n", fileName, s.storageName, targetPath, err.Error())
			ctx.Logger.Errorf("上传失败: %s - %v", file.Path, err)
			// 上传失败，保留文件
			output = append(output, file)
			uploadFailed = true
			continue
		}

		s.logs += fmt.Sprintf("上传成功: %s -> %s/%s\n", fileName, s.storageName, targetPath)
		ctx.Logger.Infof("文件上传成功: %s -> %s/%s", fileName, s.storageName, targetPath)
		uploadedIndices[len(output)] = true // 记录上传成功的文件索引
		output = append(output, file)
	}

	// 全部上传成功后，根据配置标记文件为可删除（由 Executor 在管道全部成功后统一删除）
	// 任意一个上传失败，则不标记任何文件，确保本地文件全部保留
	// 注意：不使用 Deletable 标记，避免后续阶段（如 CustomCommand）误跳过最终成品
	// 改用 Metadata["uploaded"] 标记，由 Executor 在清理时读取
	if !uploadFailed && s.uploadTiming != "immediate" {
		if s.deleteAllAfter {
			// 删除全部模式：查找视频文件关联的 .ass 字幕文件并加入 output
			// （BurnSubtitlesStage 仅在 burn_delete_ass=true 时才将 .ass 加入 output，
			//   但 delete_all 意图是删除所有文件，应包含字幕）
			assAdded := map[string]bool{}
			for _, f := range output {
				ext := strings.ToLower(filepath.Ext(f.Path))
				if ext != ".flv" && ext != ".mp4" && ext != ".mkv" && ext != ".ts" {
					continue
				}
				assPath := strings.TrimSuffix(f.Path, ext) + ".ass"
				if assAdded[assPath] {
					continue
				}
				if _, err := os.Stat(assPath); err == nil {
					// 检查 output 中是否已存在
					alreadyInOutput := false
					for _, of := range output {
						if of.Path == assPath {
							alreadyInOutput = true
							break
						}
					}
					if !alreadyInOutput {
						output = append(output, pipeline.FileInfo{
							Path: assPath,
							Type: pipeline.FileTypeOther,
						})
						assAdded[assPath] = true
						ctx.Logger.Infof("delete_all 模式：关联字幕文件 %s", assPath)
					}
				}
			}

			// 删除全部文件（含中间产物）：用 Deletable 标记
			// 跳过已是 Deletable 的中间产物（如 BurnSubtitles 标记的源视频），
			// 避免 delete_all 标记覆盖其"中间产物"身份，导致 CustomCommandStage 误执行
			for i := range output {
				if output[i].Deletable {
					// 中间产物：保留原始 Deletable 标记，不加 delete_all
					continue
				}
				output[i].Deletable = true
				if output[i].Metadata == nil {
					output[i].Metadata = map[string]any{}
				}
				output[i].Metadata["delete_all"] = true
			}
			s.logs += fmt.Sprintf("全部上传成功，已标记 %d 个文件待删除（含中间产物）\n", len(output))
			ctx.Logger.Infof("全部上传成功，已标记 %d 个文件待删除（含中间产物）", len(output))
		} else if s.deleteAfter {
			// 仅删除已上传的文件：用 Metadata["uploaded"] 标记，不设 Deletable
			count := 0
			for i := range output {
				if uploadedIndices[i] {
					if output[i].Metadata == nil {
						output[i].Metadata = map[string]any{}
					}
					output[i].Metadata["uploaded"] = true
					count++
				}
			}
			s.logs += fmt.Sprintf("全部上传成功，已标记 %d 个已上传文件待删除\n", count)
			ctx.Logger.Infof("全部上传成功，已标记 %d 个已上传文件待删除", count)
		}
	}

	// 任意上传失败，返回错误（让 Executor 将任务标记为 failed）
	if uploadFailed {
		return output, fmt.Errorf("部分文件上传失败，详见日志")
	}

	return output, nil
}

// matchFileType 检查文件类型是否匹配
func (s *CloudUploadStage) matchFileType(fileType pipeline.FileType) bool {
	for _, ft := range s.fileTypes {
		if strings.EqualFold(ft, string(fileType)) {
			return true
		}
	}
	return false
}

// renderTargetPath 渲染目标路径
func (s *CloudUploadStage) renderTargetPath(ctx *pipeline.PipelineContext, file pipeline.FileInfo) string {
	if s.pathTemplate == "" {
		// 默认路径：/录播归档/{平台}/{主播名}/{文件名}
		return fmt.Sprintf("/录播归档/%s/%s/%s",
			ctx.RecordInfo.Platform,
			ctx.RecordInfo.HostName,
			filepath.Base(file.Path),
		)
	}

	// 获取扩展名
	ext := filepath.Ext(file.Path)
	if len(ext) > 0 && ext[0] == '.' {
		ext = ext[1:]
	}

	// 模板数据
	data := struct {
		Platform string
		HostName string
		RoomName string
		FileName string
		Ext      string
	}{
		Platform: ctx.RecordInfo.Platform,
		HostName: ctx.RecordInfo.HostName,
		RoomName: ctx.RecordInfo.RoomName,
		FileName: filepath.Base(file.Path),
		Ext:      ext,
	}

	// 使用 Go 模板引擎
	funcMap := template.FuncMap{
		"date": func(format string, t time.Time) string {
			return t.Format(format)
		},
		"now": func() time.Time {
			return ctx.RecordInfo.StartTime
		},
		"trimSuffix": func(suffix, s string) string {
			return strings.TrimSuffix(s, suffix)
		},
		"ext": func(path string) string {
			return filepath.Ext(path)
		},
		"filenameFilter": func(s string) string {
			// 过滤文件名中的非法字符
			replacer := strings.NewReplacer(
				"/", "_", "\\", "_", ":", "_", "*", "_",
				"?", "_", "\"", "_", "<", "_", ">", "_", "|", "_",
			)
			return replacer.Replace(s)
		},
	}

	tmpl, err := template.New("path").Funcs(funcMap).Parse(s.pathTemplate)
	if err != nil {
		// 模板语法错误，返回空让调用方跳过上传，避免上传到错误路径
		ctx.Logger.Errorf("上传路径模板解析失败: %v", err)
		return ""
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		ctx.Logger.Errorf("上传路径模板执行失败: %v", err)
		return ""
	}

	return buf.String()
}

func (s *CloudUploadStage) GetCommands() []string {
	return s.commands
}

func (s *CloudUploadStage) GetLogs() string {
	return s.logs
}
