package danmaku

import (
	"context"
	"fmt"
	"time"

	"github.com/Akegarasu/blivedm-go/client"
	"github.com/Akegarasu/blivedm-go/message"
	"github.com/sirupsen/logrus"

	"github.com/bililive-go/bililive-go/src/configs"
)

// DanmakuRecorder 哔哩哔哩弹幕录制器
type DanmakuRecorder struct {
	baseRecorder
	roomID  int
	cookies string
	client  *client.Client
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

// Start 开始弹幕录制
func (d *DanmakuRecorder) Start(ctx context.Context) error {
	d.startAt = time.Now()

	assWriter, err := NewAssWriter(d.outputFile, d.startAt, d.cfg, "Bilibili Danmaku")
	if err != nil {
		return fmt.Errorf("failed to create ass writer: %w", err)
	}
	d.assWriter = assWriter

	c := client.NewClient(d.roomID)
	if d.cookies != "" {
		c.SetCookie(d.cookies)
	}
	d.client = c

	c.OnDanmaku(func(msg *message.Danmaku) {
		d.addDanmaku(time.Now(), msg.Sender.Uname, msg.Content, msg.Extra.Color)
	})

	if d.cfg.RecordGift != nil && *d.cfg.RecordGift {
		c.OnGift(func(msg *message.Gift) {
			if msg.Num > 0 {
				d.addGift(time.Now(), msg.Uname, msg.GiftName, msg.Num)
			}
		})
	}

	if d.cfg.RecordGuard != nil && *d.cfg.RecordGuard {
		c.OnGuardBuy(func(msg *message.GuardBuy) {
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

	if err := c.Start(); err != nil {
		assWriter.Close()
		return fmt.Errorf("failed to start danmaku client: %w", err)
	}

	d.running = true

	go func() {
		<-ctx.Done()
		d.Stop()
	}()

	return nil
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
