package live

import (
	"testing"
	"time"
)

// 未加载全局配置时 getConfiguredInterval 会直接返回默认间隔，
// 因此可以直接构造一个空的 WrappedLive 来验证退避曲线。
func TestNextRequestIntervalLocked(t *testing.T) {
	tests := []struct {
		name     string
		failures int
		want     time.Duration
	}{
		{name: "无失败时使用配置间隔", failures: 0, want: defaultInterval},
		{name: "一次失败翻倍", failures: 1, want: 2 * defaultInterval},
		{name: "两次失败四倍", failures: 2, want: 4 * defaultInterval},
		{name: "多次失败后封顶", failures: 100, want: maxFailureBackoff},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := &WrappedLive{consecutiveFailures: tt.failures}
			if got := w.nextRequestIntervalLocked(); got != tt.want {
				t.Errorf("consecutiveFailures=%d: got %v, want %v", tt.failures, got, tt.want)
			}
		})
	}
}

// 退避间隔必须单调不减，且永远不会超过上限，
// 否则失败时的请求频率反而会高于正常轮询频率。
func TestNextRequestIntervalNeverShrinksBelowConfigured(t *testing.T) {
	prev := time.Duration(0)
	for failures := 0; failures < 64; failures++ {
		w := &WrappedLive{consecutiveFailures: failures}
		got := w.nextRequestIntervalLocked()
		if got < defaultInterval {
			t.Fatalf("consecutiveFailures=%d: 退避间隔 %v 小于配置间隔 %v", failures, got, defaultInterval)
		}
		if got > maxFailureBackoff {
			t.Fatalf("consecutiveFailures=%d: 退避间隔 %v 超过上限 %v", failures, got, maxFailureBackoff)
		}
		if got < prev {
			t.Fatalf("consecutiveFailures=%d: 退避间隔 %v 小于上一次的 %v", failures, got, prev)
		}
		prev = got
	}
}
