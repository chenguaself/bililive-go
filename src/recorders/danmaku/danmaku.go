package danmaku

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/Akegarasu/blivedm-go/client"
	"github.com/Akegarasu/blivedm-go/message"
	"github.com/sirupsen/logrus"

	"github.com/bililive-go/bililive-go/src/configs"
)

// DanmakuRecorder 哔哩哔哩弹幕录制器
type DanmakuRecorder struct {
	baseRecorder
	roomID       int
	cookies      string
	client       *client.Client
	lastActivity atomic.Int64 // 最后一次收到消息的时间戳（UnixNano）
}

// NewDanmakuRecorder 创建哔哩哔哩弹幕录制器
func NewDanmakuRecorder(roomID int, cookies string, outputFile string, cfg configs.DanmakuConfig, logger *logrus.Entry) *DanmakuRecorder {
	return &DanmakuRecorder{
		baseRecorder: baseRecorder{
			outputFile: outputFile,
			cfg:        cfg,
			logger:     logger,
		},
		roomID:  roomID,
		cookies: cookies,
	}
}

// createClient 创建并配置 blivedm-go 客户端
func (d *DanmakuRecorder) createClient() *client.Client {
	c := client.NewClient(d.roomID)
	if d.cookies != "" {
		c.SetCookie(d.cookies)
	}

	c.OnDanmaku(func(msg *message.Danmaku) {
		d.lastActivity.Store(time.Now().UnixNano())
		d.addDanmaku(time.Now(), msg.Sender.Uname, msg.Content, msg.Extra.Color)
	})

	if d.cfg.RecordGift != nil && *d.cfg.RecordGift {
		c.OnGift(func(msg *message.Gift) {
			d.lastActivity.Store(time.Now().UnixNano())
			if msg.Num > 0 {
				d.addGift(time.Now(), msg.Uname, msg.GiftName, msg.Num)
			}
		})
	}

	if d.cfg.RecordGuard != nil && *d.cfg.RecordGuard {
		c.OnGuardBuy(func(msg *message.GuardBuy) {
			d.lastActivity.Store(time.Now().UnixNano())
			d.mu.Lock()
			if !d.running || d.assWriter == nil {
				d.mu.Unlock()
				return
			}
			d.assWriter.AddGuard(time.Now(), msg.Username, msg.GiftName)
			d.count++
			d.mu.Unlock()
		})
	}

	if d.cfg.RecordSuperChat != nil && *d.cfg.RecordSuperChat {
		c.OnSuperChat(func(msg *message.SuperChat) {
			d.lastActivity.Store(time.Now().UnixNano())
			d.mu.Lock()
			if !d.running || d.assWriter == nil {
				d.mu.Unlock()
				return
			}
			d.assWriter.AddSuperChat(time.Now(), msg.UserInfo.Uname, msg.Message, msg.Price)
			d.count++
			d.mu.Unlock()
		})
	}

	return c
}

// Start 开始弹幕录制
func (d *DanmakuRecorder) Start(ctx context.Context) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.running {
		return nil
	}

	d.startAt = time.Now()

	assWriter, err := NewAssWriter(d.outputFile, d.startAt, d.cfg, "Bilibili Danmaku")
	if err != nil {
		return fmt.Errorf("failed to create ass writer: %w", err)
	}
	d.assWriter = assWriter

	c := d.createClient()
	d.client = c

	if err := c.Start(); err != nil {
		assWriter.Close()
		d.assWriter = nil
		return fmt.Errorf("failed to start danmaku client: %w", err)
	}

	d.running = true
	d.lastActivity.Store(time.Now().UnixNano())
	d.logger.Info("弹幕录制已启动")

	go func() {
		<-ctx.Done()
		d.Stop()
	}()

	// 启动健康检测
	go d.healthCheckLoop(ctx)

	return nil
}

// healthCheckLoop 定期检测弹幕连接健康状态
// 如果超过 90 秒没有收到任何消息（弹幕、礼物、心跳响应），认为连接已死并自动重启
func (d *DanmakuRecorder) healthCheckLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !d.IsRunning() {
				return
			}

			lastTime := d.lastActivity.Load()
			silent := time.Since(time.Unix(0, lastTime))

			if silent > 90*time.Second {
				d.logger.Warnf("弹幕连接已静默 %v，尝试重启连接", silent.Round(time.Second))
				d.restartClient()
			}
		}
	}
}

// restartClient 重启弹幕客户端
func (d *DanmakuRecorder) restartClient() {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return
	}

	// 停止旧客户端
	if d.client != nil {
		d.client.Stop()
		d.client = nil
	}

	// 创建并启动新客户端
	c := d.createClient()
	d.client = c
	if err := c.Start(); err != nil {
		d.logger.WithError(err).Warn("重启弹幕客户端失败")
		d.client = nil
		d.mu.Unlock()
		return
	}

	d.lastActivity.Store(time.Now().UnixNano())
	d.mu.Unlock()
	d.logger.Info("弹幕客户端已重启")
}

// Stop 停止弹幕录制
func (d *DanmakuRecorder) Stop() {
	w := d.stopBase()
	c := d.client
	d.client = nil
	if c != nil {
		c.Stop()
	}
	if w != nil {
		w.Close()
	}
	count := d.GetCount()
	if count > 0 {
		d.logger.Infof("弹幕录制已停止，共录制 %d 条弹幕 -> %s", count, d.outputFile)
	} else {
		d.logger.Info("弹幕录制已停止，未收到弹幕")
	}
}
