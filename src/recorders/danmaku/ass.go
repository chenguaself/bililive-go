package danmaku

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bililive-go/bililive-go/src/configs"
)

// AssWriter writes danmaku entries to an ASS (Advanced SubStation Alpha) subtitle file.
type AssWriter struct {
	mu          sync.Mutex
	file        *os.File
	startAt     time.Time
	cfg         configs.DanmakuConfig
	resX        int
	resY        int
	bannerSpeed int // ASS Banner speed (ms per pixel shift)
	laneNum     int
	nextLane    int
	laneLast    []int64 // last end time (centiseconds) per lane
}

// parseResolution parses "1920x1080" into (1920, 1080).
func parseResolution(res string) (int, int) {
	parts := strings.SplitN(res, "x", 2)
	if len(parts) != 2 {
		return 1920, 1080
	}
	x, err1 := strconv.Atoi(parts[0])
	y, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return 1920, 1080
	}
	return x, y
}

// NewAssWriter creates a new ASS writer.
func NewAssWriter(filePath string, startAt time.Time, cfg configs.DanmakuConfig) (*AssWriter, error) {
	f, err := os.Create(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create ass file: %w", err)
	}

	resX, resY := parseResolution(cfg.Resolution)
	// Banner speed: ms per pixel = scroll_time * 1000 / screen_width
	bannerSpeed := cfg.ScrollTime * 1000 / resX
	if bannerSpeed < 1 {
		bannerSpeed = 1
	}
	laneHeight := cfg.FontSize + 4
	laneNum := resY / laneHeight

	w := &AssWriter{
		file:        f,
		startAt:     startAt,
		cfg:         cfg,
		resX:        resX,
		resY:        resY,
		bannerSpeed: bannerSpeed,
		laneNum:     laneNum,
		nextLane:    0,
		laneLast:    make([]int64, laneNum),
	}

	if err := w.writeHeader(); err != nil {
		f.Close()
		return nil, err
	}
	return w, nil
}

func (w *AssWriter) writeHeader() error {
	assAlpha := 255 - w.cfg.Opacity
	backColor := fmt.Sprintf("&H%02X000000&", assAlpha)

	header := fmt.Sprintf(`[Script Info]
Title: Bilibili Danmaku
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
PlayResX: %d
PlayResY: %d

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Danmaku,%s,%d,&H00FFFFFF,&H000000FF,&H00000000,%s,0,0,0,0,100,100,0,0,1,%d,0,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`, w.resX, w.resY, w.cfg.FontName, w.cfg.FontSize, backColor, w.cfg.Outline)
	_, err := w.file.WriteString(header)
	return err
}

// estimateTextWidth estimates the pixel width of danmaku text.
// CJK characters are ~fontSize wide, ASCII characters are ~fontSize*0.5 wide.
func (w *AssWriter) estimateTextWidth(text string) int {
	width := 0
	for _, r := range text {
		if r > 0x7F {
			width += w.cfg.FontSize // CJK character
		} else {
			width += w.cfg.FontSize / 2 // ASCII character
		}
	}
	return width
}

// AddDanmaku appends a single danmaku line to the ASS file.
// The dialogue duration is dynamically calculated so the text scrolls completely
// from the right edge to the left edge of the screen.
func (w *AssWriter) AddDanmaku(recvAt time.Time, username, text string, color int) {
	w.mu.Lock()
	defer w.mu.Unlock()

	elapsed := recvAt.Sub(w.startAt)
	startCS := int64(elapsed / (10 * time.Millisecond))
	if startCS < 0 {
		startCS = 0
	}

	// Calculate dialogue duration: enough for text to fully scroll across screen
	// Total distance = screen width + text width (pixels)
	// Duration (ms) = distance * bannerSpeed
	// Duration (centiseconds) = duration_ms / 10
	fullText := username + ": " + text
	textWidth := w.estimateTextWidth(fullText)
	totalDistance := w.resX + textWidth
	durationCS := int64(totalDistance * w.bannerSpeed / 10)
	if durationCS < 200 { // minimum 2 seconds
		durationCS = 200
	}
	endCS := startCS + durationCS

	lane := w.assignLane(startCS, endCS)
	laneHeight := w.cfg.FontSize + 4
	marginV := lane * laneHeight

	if color <= 0 {
		color = 16777215
	}
	assColor := rgbToAssColor(color)

	line := fmt.Sprintf("Dialogue: 0,%s,%s,Danmaku,,0,0,%d,Banner;%d;0;30,{\\c%s}%s\n",
		formatTime(startCS), formatTime(endCS), marginV, w.bannerSpeed, assColor, escapeText(fullText))

	w.file.WriteString(line)
	w.file.Sync()
}

// assignLane finds the next available vertical lane.
func (w *AssWriter) assignLane(startCS, endCS int64) int {
	for i := 0; i < w.laneNum; i++ {
		idx := (w.nextLane + i) % w.laneNum
		if w.laneLast[idx] <= startCS {
			w.laneLast[idx] = endCS
			w.nextLane = (idx + 1) % w.laneNum
			return idx
		}
	}
	earliest := 0
	for i := 1; i < w.laneNum; i++ {
		if w.laneLast[i] < w.laneLast[earliest] {
			earliest = i
		}
	}
	w.laneLast[earliest] = endCS
	w.nextLane = (earliest + 1) % w.laneNum
	return earliest
}

func (w *AssWriter) OutputPath() string {
	return w.file.Name()
}

func (w *AssWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file != nil {
		return w.file.Close()
	}
	return nil
}

func formatTime(cs int64) string {
	h := cs / 360000
	m := (cs % 360000) / 6000
	s := (cs % 6000) / 100
	c := cs % 100
	return fmt.Sprintf("%d:%02d:%02d.%02d", h, m, s, c)
}

func rgbToAssColor(rgb int) string {
	r := (rgb >> 16) & 0xFF
	g := (rgb >> 8) & 0xFF
	b := rgb & 0xFF
	return fmt.Sprintf("&H00%02X%02X%02X&", b, g, r)
}

func escapeText(s string) string {
	result := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			result = append(result, '\\', 'n')
		} else if s[i] == '\r' {
			// skip
		} else {
			result = append(result, s[i])
		}
	}
	return string(result)
}
