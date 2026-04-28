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

// DanmakuRecorder connects to a Bilibili live room via WebSocket,
// receives danmaku messages, and writes them to an ASS subtitle file.
type DanmakuRecorder struct {
	roomID     int
	cookies    string
	outputFile string
	cfg        configs.DanmakuConfig
	startAt    time.Time
	assWriter  *AssWriter
	client     *client.Client
	logger     *logrus.Entry
	count      int
}

// NewDanmakuRecorder creates a new danmaku recorder.
func NewDanmakuRecorder(roomID int, cookies string, outputFile string, cfg configs.DanmakuConfig, logger *logrus.Entry) *DanmakuRecorder {
	return &DanmakuRecorder{
		roomID:     roomID,
		cookies:    cookies,
		outputFile: outputFile,
		cfg:        cfg,
		logger:     logger,
	}
}

// Start begins recording danmaku.
func (d *DanmakuRecorder) Start(ctx context.Context) error {
	d.startAt = time.Now()

	assWriter, err := NewAssWriter(d.outputFile, d.startAt, d.cfg)
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
		d.count++
		d.assWriter.AddDanmaku(
			time.Now(),
			msg.Sender.Uname,
			msg.Content,
			msg.Extra.Color,
		)
	})

	if err := c.Start(); err != nil {
		assWriter.Close()
		return fmt.Errorf("failed to start danmaku client: %w", err)
	}

	go func() {
		<-ctx.Done()
		d.Stop()
	}()

	return nil
}

// Stop stops the danmaku recorder.
func (d *DanmakuRecorder) Stop() {
	if d.client != nil {
		d.client.Stop()
		d.client = nil
	}
	if d.assWriter != nil {
		d.assWriter.Close()
		d.assWriter = nil
	}
	if d.count > 0 {
		d.logger.Infof("弹幕录制已停止，共录制 %d 条弹幕 -> %s", d.count, d.outputFile)
	} else {
		d.logger.Info("弹幕录制已停止，未收到弹幕")
	}
}

// OutputFile returns the path of the ASS output file.
func (d *DanmakuRecorder) OutputFile() string {
	return d.outputFile
}

// GetCount returns the number of danmaku received so far.
func (d *DanmakuRecorder) GetCount() int {
	return d.count
}

// IsRunning returns whether the danmaku WebSocket client is active.
func (d *DanmakuRecorder) IsRunning() bool {
	return d.client != nil
}

// GetStatus returns the current danmaku recording status.
func (d *DanmakuRecorder) GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"danmaku_running":    d.IsRunning(),
		"danmaku_count":      d.count,
		"danmaku_output":     d.outputFile,
	}
}
