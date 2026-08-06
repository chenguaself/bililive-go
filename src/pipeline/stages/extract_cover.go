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
	config       pipeline.StageConfig
	storageName  string
	pathTemplate string
	deleteAfter  bool
	uploadTiming string // immediate 或 after_process
	fileTypes    []string // 过滤的文件类型，空表示所有
	commands     []string
	logs         string
}

// NewCloudUploadStage 创建云上传阶段工厂
func NewCloudUploadStage(config pipeline.StageConfig) (pipeline.Stage, error) {
	return &CloudUploadStage{
		config:       config,
		storageName:  config.GetStringOption(pipeline.OptionStorage, ""),
		pathTemplate: config.GetStringOption(pipeline.OptionPathTemplate, ""),
		deleteAfter:  config.GetBoolOption(pipeline.OptionDeleteAfter, false),
		uploadTiming: config.GetStringOption(pipeline.OptionUploadTiming, ""),
		fileTypes:    config.GetStringSliceOption(pipeline.OptionFileTypes),
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
		s.logs = "OpenList 管理器未初始化，跳过上传\n"
		return input, nil
	}

	// 获取配置并创建客户端
	config := configs.GetCurrentConfig()

	client, err := mgr.GetClient(ctx.Ctx, config.OpenList.Token, config.OpenList.Username, config.OpenList.Password)
	if err != nil {
		s.logs += fmt.Sprintf("创建 OpenList 客户端失败: %s\n", err.Error())
		return input, fmt.Errorf("创建 OpenList 客户端失败: %w", err)
	}

	// 如果 token 变化了（通过用户名密码登录获取了新 token），自动写回配置
	if newToken := client.GetCurrentToken(); newToken != "" && newToken != config.OpenList.Token {
		config.OpenList.Token = newToken
		if err := config.Marshal(); err != nil {
			ctx.Logger.Warnf("保存 OpenList token 到配置文件失败: %v", err)
		} else {
			ctx.Logger.Info("OpenList token 已自动更新到配置文件")
		}
	}

	var output []pipeline.FileInfo

	for _, file := range input {
		// 文件类型过滤
		if len(s.fileTypes) > 0 && !s.matchFileType(file.Type) {
			output = append(output, file)
			continue
		}

		// 检查文件是否存在
		if _, err := os.Stat(file.Path); os.IsNotExist(err) {
			s.logs += fmt.Sprintf("文件不存在: %s\n", file.Path)
			continue
		}

		// 渲染目标路径
		targetPath := s.renderTargetPath(ctx, file)
		if targetPath == "" {
			s.logs += fmt.Sprintf("无法生成目标路径: %s\n", file.Path)
			output = append(output, file)
			continue
		}

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
		var lastPct float64
		err := client.Upload(ctx.Ctx, file.Path, fullRemotePath, func(p openlist.UploadProgress) {
			// 每 10% 报告一次进度
			if p.Percentage-lastPct >= 10 || p.Percentage >= 100 {
				lastPct = p.Percentage
				speedMB := float64(p.SpeedBytesPerSec) / 1024 / 1024
				ctx.Logger.Infof("上传进度 [%s]: %.1f%% (%.1f MB/s, 剩余 %ds)",
					fileName, p.Percentage, speedMB, p.EtaSeconds)
			}
		})

		if err != nil {
			s.logs += fmt.Sprintf("上传失败: %s -> %s/%s - %s\n", fileName, s.storageName, targetPath, err.Error())
			ctx.Logger.Errorf("上传失败: %s - %v", file.Path, err)
			// 上传失败，保留文件
			output = append(output, file)
			continue
		}

		s.logs += fmt.Sprintf("上传成功: %s -> %s/%s\n", fileName, s.storageName, targetPath)
		ctx.Logger.Infof("文件上传成功: %s -> %s/%s", fileName, s.storageName, targetPath)

		// 立即上传模式：始终保留文件，后续阶段（修复/转换/烧录）会处理删除
		// 后处理上传模式：如果配置了删除，则删除文件（此时已是最终文件）
		if s.deleteAfter && s.uploadTiming != "immediate" {
			if err := os.Remove(file.Path); err != nil {
				// 删除失败，保留文件在输出中供后续阶段使用
				s.logs += fmt.Sprintf("删除本地文件失败: %s - %s\n", fileName, err.Error())
				ctx.Logger.Warnf("删除本地文件失败: %s - %v", file.Path, err)
				output = append(output, file)
			} else {
				s.logs += fmt.Sprintf("已删除本地文件: %s\n", fileName)
			}
		} else {
			// 保留文件在输出中
			output = append(output, file)
		}
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
			return time.Now()
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
		// 模板解析失败，回退到简单替换
		return s.fallbackRender(data)
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		// 模板执行失败，回退到简单替换
		return s.fallbackRender(data)
	}

	return buf.String()
}

// fallbackRender 简单字符串替换（模板引擎失败时的回退方案）
func (s *CloudUploadStage) fallbackRender(data struct {
	Platform string
	HostName string
	RoomName string
	FileName string
	Ext      string
}) string {
	path := s.pathTemplate
	path = strings.ReplaceAll(path, "{{ .Platform }}", data.Platform)
	path = strings.ReplaceAll(path, "{{.Platform}}", data.Platform)
	path = strings.ReplaceAll(path, "{{ .HostName }}", data.HostName)
	path = strings.ReplaceAll(path, "{{.HostName}}", data.HostName)
	path = strings.ReplaceAll(path, "{{ .RoomName }}", data.RoomName)
	path = strings.ReplaceAll(path, "{{.RoomName}}", data.RoomName)
	path = strings.ReplaceAll(path, "{{ .FileName }}", data.FileName)
	path = strings.ReplaceAll(path, "{{.FileName}}", data.FileName)
	path = strings.ReplaceAll(path, "{{ .Ext }}", data.Ext)
	path = strings.ReplaceAll(path, "{{.Ext}}", data.Ext)
	return path
}

func (s *CloudUploadStage) GetCommands() []string {
	return s.commands
}

func (s *CloudUploadStage) GetLogs() string {
	return s.logs
}
