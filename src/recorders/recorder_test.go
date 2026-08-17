package recorders

import (
	"context"
	"net/url"
	"strings"
	"testing"

	"github.com/bluele/gcache"
	"github.com/sirupsen/logrus"
	gomock "go.uber.org/mock/gomock"

	"github.com/bililive-go/bililive-go/src/configs"
	"github.com/bililive-go/bililive-go/src/live"
	livemock "github.com/bililive-go/bililive-go/src/live/mock"
	"github.com/bililive-go/bililive-go/src/pkg/events"
	eventsmock "github.com/bililive-go/bililive-go/src/pkg/events/mock"
	"github.com/bililive-go/bililive-go/src/pkg/livelogger"
)

func TestTryRecordStopsWithoutPanicWhenFilenameRenderFails(t *testing.T) {
	previousConfig := configs.GetCurrentConfig()
	cfg := configs.NewConfig()
	cfg.OutputTmpl = `{{ fail "render failed" }}`
	configs.SetCurrentConfig(cfg)
	t.Cleanup(func() {
		configs.SetCurrentConfig(previousConfig)
	})

	ctrl := gomock.NewController(t)
	l := livemock.NewMockLive(ctrl)
	logger := livelogger.New(0, logrus.Fields{"test": t.Name()})
	streamURL := &url.URL{Scheme: "https", Host: "example.com", Path: "/stream.flv"}

	l.EXPECT().GetRawUrl().Return("https://example.com/room").AnyTimes()
	l.EXPECT().GetStreamInfos().Return([]*live.StreamUrlInfo{{Url: streamURL}}, nil)
	l.EXPECT().GetLogger().Return(logger)

	// 渲染失败时 recorder 应请求 manager 仅回收自身，而不是错误派发 LiveEnd。
	ed := eventsmock.NewMockDispatcher(ctrl)
	ed.EXPECT().DispatchEvent(events.NewEvent(RecorderStopRequested, l))

	cache := gcache.New(1).LRU().Build()
	if err := cache.Set(l, &live.Info{Live: l}); err != nil {
		t.Fatalf("写入直播信息缓存失败: %v", err)
	}
	r := &recorder{Live: l, cache: cache, ed: ed}

	r.tryRecord(context.Background())

	logs := logger.GetLogs()
	if !strings.Contains(logs, "failed to render filename, stopping recorder") {
		t.Fatalf("未记录文件名渲染失败日志: %s", logs)
	}
	if !strings.Contains(logs, "render failed") {
		t.Fatalf("日志未保留原始模板错误: %s", logs)
	}
}
