package danmaku

import (
	"context"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/recorders/danmaku/douyu"
)

type DouyuDanmakuRecorder struct {
	roomID     string
	cookies    string
	outputFile string
	cfg        configs.DanmakuConfig
	startAt    time.Time
	assWriter  *AssWriter
	client     *douyu.DouyuClient
	logger     *logrus.Entry
	count      int
	mu         sync.Mutex
	running    bool
}

func NewDouyuDanmakuRecorder(roomID, cookies, outputFile string, cfg configs.DanmakuConfig, logger *logrus.Entry) *DouyuDanmakuRecorder {
	return &DouyuDanmakuRecorder{
		roomID:     roomID,
		cookies:    cookies,
		outputFile: outputFile,
		cfg:        cfg,
		logger:     logger,
	}
}

func (r *DouyuDanmakuRecorder) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.running {
		return nil
	}

	startAt := time.Now()

	assWriter, err := NewAssWriter(r.outputFile, startAt, r.cfg, "Douyu Danmaku")
	if err != nil {
		return err
	}
	r.assWriter = assWriter

	var onGift func(username, giftName string, num int)
	if r.cfg.RecordDouyuGift != nil && *r.cfg.RecordDouyuGift {
		onGift = r.onGift
	}

	r.client = douyu.NewDouyuClient(r.roomID, r.cookies, r.onDanmaku, onGift, r.logger)

	if err := r.client.Start(ctx); err != nil {
		assWriter.Close()
		return err
	}

	r.startAt = startAt
	r.running = true
	r.logger.Info("斗鱼弹幕录制已启动")

	return nil
}

func (r *DouyuDanmakuRecorder) Stop() {
	r.mu.Lock()
	if !r.running {
		r.mu.Unlock()
		return
	}

	r.running = false
	client := r.client
	writer := r.assWriter
	r.client = nil
	r.assWriter = nil
	count := r.count
	r.mu.Unlock()

	if client != nil {
		client.Stop()
	}
	if writer != nil {
		writer.Close()
	}

	r.logger.Infof("斗鱼弹幕录制已停止，共录制 %d 条弹幕", count)
}

func (r *DouyuDanmakuRecorder) OutputFile() string {
	return r.outputFile
}

func (r *DouyuDanmakuRecorder) GetCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.count
}

func (r *DouyuDanmakuRecorder) IsRunning() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

func (r *DouyuDanmakuRecorder) GetStatus() map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()

	status := map[string]interface{}{
		"danmaku_running": r.running,
		"danmaku_count":   r.count,
		"danmaku_output":  r.outputFile,
	}
	if r.running {
		status["danmaku_start_time"] = r.startAt.Format(time.RFC3339)
	}
	return status
}

func (r *DouyuDanmakuRecorder) onDanmaku(username, content string, color int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.running || r.assWriter == nil {
		return
	}

	r.assWriter.AddDanmaku(time.Now(), username, content, color)
	r.count++
}

func (r *DouyuDanmakuRecorder) onGift(username, giftName string, num int) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.running || r.assWriter == nil {
		return
	}

	r.assWriter.AddGift(time.Now(), username, giftName, num)
	r.count++
}
