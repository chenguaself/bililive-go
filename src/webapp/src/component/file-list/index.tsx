import React, { useState, useEffect, useCallback, useRef } from "react";
import API from "../../utils/api";
import { Breadcrumb, Table, Button, Modal, Input, Popconfirm, message, Space, Tooltip } from "antd";
import {
    // @ts-ignore
    FolderOutlined,
    // @ts-ignore
    FileOutlined,
    // @ts-ignore
    CloseOutlined,
    // @ts-ignore
    EditOutlined,
    // @ts-ignore
    DeleteOutlined
} from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import Utils from "../../utils/common";
import './file-list.css';
import Artplayer from "artplayer";
import mpegtsjs from "mpegts.js";

const api = new API();

// ==================== ASS 弹幕解析 ====================

/** 解析 ASS 时间格式 H:MM:SS.CC 为秒数 */
function parseAssTime(s: string): number {
    const p = s.trim().split(':');
    if (p.length !== 3) return 0;
    const sp = p[2].split('.');
    return (parseInt(p[0]) || 0) * 3600 + (parseInt(p[1]) || 0) * 60 + (parseInt(sp[0]) || 0) + (parseInt(sp[1] || '0') || 0) / 100;
}

/** ASS &HAABBGGRR& → CSS rgba */
function parseAssColor(c: string): string {
    const h = c.replace(/[&H]/gi, '').padStart(8, '0');
    const b = parseInt(h.substring(2, 4), 16);
    const g = parseInt(h.substring(4, 6), 16);
    const r = parseInt(h.substring(6, 8), 16);
    const a = 1 - parseInt(h.substring(0, 2), 16) / 255;
    return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

type DanmakuEntry = { start: number; end: number; color: string; text: string; style: string; align: number };

/** 解析 ASS 文件，提取所有弹幕条目 */
function parseAss(content: string): { items: DanmakuEntry[]; scrollTime: number } {
    const lines = content.split('\n');
    const items: DanmakuEntry[] = [];
    let inStyles = false;
    let inEvents = false;
    let resX = 1920;
    let bannerSpeed = 80; // ms per pixel
    // 样式名 → PrimaryColour CSS 颜色
    const styleColors: Record<string, string> = {};

    for (const line of lines) {
        const mr = line.match(/^PlayResX:\s*(\d+)/);
        if (mr) resX = parseInt(mr[1]);

        // 解析样式定义中的 PrimaryColour
        if (line.trim() === '[V4+ Styles]') { inStyles = true; inEvents = false; continue; }
        if (line.trim() === '[Events]') { inEvents = true; inStyles = false; continue; }
        if (line.startsWith('[')) { inStyles = false; inEvents = false; continue; }

        if (inStyles && line.startsWith('Style:')) {
            // Style: Name, Fontname, Fontsize, PrimaryColour, ...
            const sp = line.substring('Style:'.length).split(',');
            if (sp.length >= 4) {
                const name = sp[0].trim();
                const pc = sp[3].trim();
                styleColors[name] = parseAssColor(pc);
            }
            continue;
        }

        if (!inEvents) continue;
        if (!line.startsWith('Dialogue:')) continue;

        const parts = line.substring('Dialogue:'.length).split(',');
        if (parts.length < 10) continue;

        const style = parts[3].trim();
        const effect = parts[8].trim();

        // 提取 Banner 速度（仅滚动弹幕用）
        if (effect.startsWith('Banner;')) {
            const ep = effect.split(';');
            if (ep.length >= 2) bannerSpeed = parseInt(ep[1]) || 80;
        }

        const start = parseAssTime(parts[1]);
        const end = parseAssTime(parts[2]);
        const raw = parts.slice(9).join(',');
        // 优先使用 Dialogue 行中的 {\c} 覆盖色，否则回退到样式定义的 PrimaryColour
        let color = styleColors[style] || 'rgba(255,255,255,1)';
        const cm = raw.match(/\\c([^}]+)/);
        if (cm) color = parseAssColor(cm[1]);
        // 提取 {\an} 对齐覆盖（用于定位 SC/上舰消息）
        let align = 0;
        const am = raw.match(/\\an(\d+)/);
        if (am) align = parseInt(am[1]);
        const text = raw.replace(/\{[^}]*\}/g, '');
        if (end > start && text) items.push({ start, end, color, text, style, align });
    }

    return { items, scrollTime: (bannerSpeed * resX) / 1000 };
}

// ==================== 弹幕渲染器 ====================

const DANMAKU_FONT_SIZE = 22;
const DANMAKU_GAP = 50;      // 同轨道弹幕间隔（px）

/**
 * 弹幕渲染器 — 核心：同轨道可同时显示多条弹幕
 * 使用 requestAnimationFrame 手动控制 left 位置，而非 CSS animation，
 * 这样可以精确跟踪每条弹幕的右边缘，实现真正的多弹幕同轨。
 * 同时支持固定位置的消息（Guard/SC/Toast）。
 */
class DanmakuRenderer {
    private overlay: HTMLDivElement;
    private video: HTMLVideoElement;
    private items: DanmakuEntry[];
    private scrollTime: number;
    private rafId = 0;
    private running = false;
    private nextIdx = 0;
    // 滚动弹幕轨道
    private lanes: Array<{ el: HTMLDivElement; spawnTime: number; rightEdgeOutTime: number; tailEnterTime: number }[]> = [];
    private laneCount = 0;
    // 固定位置消息（按位置分组堆叠）
    private fixedEls: { el: HTMLDivElement; endTime: number; posKey: string }[] = [];
    // 滚动样式白名单
    private static SCROLL_STYLES = new Set(['Danmaku', 'Gift']);

    constructor(overlay: HTMLDivElement, video: HTMLVideoElement, items: DanmakuEntry[], scrollTime: number) {
        this.overlay = overlay;
        this.video = video;
        this.items = items.slice().sort((a, b) => a.start - b.start);
        this.scrollTime = scrollTime;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.nextIdx = 0;
        this.laneCount = Math.max(1, Math.floor(this.overlay.clientHeight / (DANMAKU_FONT_SIZE + 4)));
        this.lanes = Array.from({ length: this.laneCount }, () => []);
        this.rafId = requestAnimationFrame(this.tick);
    }

    stop() {
        this.running = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
        this.rafId = 0;
        this.overlay.innerHTML = '';
        this.lanes = [];
        this.fixedEls = [];
    }

    /** 跳转到指定时间：清理已有弹幕，用二分查找跳过已过去的弹幕 */
    seek(time: number) {
        // 清理 DOM 和轨道
        for (const lane of this.lanes) {
            for (const d of lane) d.el.remove();
        }
        this.lanes = Array.from({ length: this.laneCount }, () => []);
        for (const f of this.fixedEls) f.el.remove();
        this.fixedEls = [];

        // 二分查找：找到第一个 start > time 的索引
        let lo = 0, hi = this.items.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.items[mid].start <= time) lo = mid + 1;
            else hi = mid;
        }
        this.nextIdx = lo;
    }

    private tick = () => {
        if (!this.running) return;
        this.rafId = requestAnimationFrame(this.tick);
        if (this.video.paused || this.video.seeking) return;

        const t = this.video.currentTime;
        const cw = this.overlay.clientWidth || 1;

        // 1. 清理已完全滚出的弹幕
        for (const lane of this.lanes) {
            while (lane.length > 0 && lane[0].rightEdgeOutTime <= t) {
                lane[0].el.remove();
                lane.shift();
            }
        }

        // 2. 清理过期的固定位置消息
        let fixedChanged = false;
        for (let i = this.fixedEls.length - 1; i >= 0; i--) {
            if (this.fixedEls[i].endTime <= t) {
                this.fixedEls[i].el.remove();
                this.fixedEls.splice(i, 1);
                fixedChanged = true;
            }
        }
        // 有消息过期后重新布局，消除空隙
        if (fixedChanged) this.relayoutFixed();

        // 3. 发射新弹幕
        while (this.nextIdx < this.items.length && this.items[this.nextIdx].start <= t) {
            const item = this.items[this.nextIdx];
            if (DanmakuRenderer.SCROLL_STYLES.has(item.style)) {
                this.spawnScroll(item, t, cw);
            } else {
                this.spawnFixed(item, t);
            }
            this.nextIdx++;
        }

        // 4. 更新所有滚动弹幕位置
        for (const lane of this.lanes) {
            for (const d of lane) {
                const elapsed = t - d.spawnTime;
                const progress = elapsed / this.scrollTime;
                const el = d.el;
                const twPct = parseFloat(el.dataset.tw || '20');
                const leftPct = 100 - progress * (100 + twPct);
                el.style.left = leftPct + '%';
            }
        }
    };

    private spawnScroll(item: DanmakuEntry, t: number, cw: number) {
        // 估算弹幕宽度（px）→ 转为容器百分比
        let textPx = 0;
        for (const ch of item.text) textPx += ch.charCodeAt(0) > 0x7F ? DANMAKU_FONT_SIZE : DANMAKU_FONT_SIZE * 0.6;
        const twPct = (textPx / cw) * 100;

        // 尾部进入屏幕的时间 = 发射时间 + textWidth/containerWidth * scrollTime
        const textEnterTime = t + (textPx / cw) * this.scrollTime;
        // 完全滚出时间
        const rightEdgeOutTime = t + this.scrollTime;
        // 安全间隔时间
        const safeGapTime = (DANMAKU_GAP / cw) * this.scrollTime;

        // 寻找可容纳的轨道
        let laneIdx = -1;
        for (let i = 0; i < this.laneCount; i++) {
            const lane = this.lanes[i];
            if (lane.length === 0) { laneIdx = i; break; }
            const last = lane[lane.length - 1];
            // 条件：最后一条弹幕的尾部已进入屏幕 + 安全间隔
            if (t >= last.tailEnterTime + safeGapTime) { laneIdx = i; break; }
        }
        if (laneIdx < 0) {
            let minLen = Infinity;
            for (let i = 0; i < this.laneCount; i++) {
                if (this.lanes[i].length < minLen) { minLen = this.lanes[i].length; laneIdx = i; }
            }
        }
        if (laneIdx < 0) return;

        // 创建 DOM
        const el = document.createElement('div');
        el.className = 'danmaku-item';
        el.textContent = item.text;
        el.style.color = item.color;
        el.style.fontSize = DANMAKU_FONT_SIZE + 'px';
        el.style.lineHeight = (DANMAKU_FONT_SIZE + 4) + 'px';
        el.style.textShadow = '1px 1px 2px rgba(0,0,0,0.8),-1px -1px 2px rgba(0,0,0,0.8),1px -1px 2px rgba(0,0,0,0.8),-1px 1px 2px rgba(0,0,0,0.8)';
        el.style.top = (laneIdx * (DANMAKU_FONT_SIZE + 4)) + 'px';
        el.style.left = '100%';
        el.dataset.tw = twPct.toString();

        this.overlay.appendChild(el);
        this.lanes[laneIdx].push({ el, spawnTime: t, rightEdgeOutTime, tailEnterTime: textEnterTime });
    }

    /** 重新布局固定位置消息，消除过期后留下的空隙 */
    private relayoutFixed() {
        // 按位置分组，每组内重新计算堆叠偏移
        const groups: Record<string, { el: HTMLDivElement }[]> = {};
        for (const f of this.fixedEls) {
            if (!groups[f.posKey]) groups[f.posKey] = [];
            groups[f.posKey].push(f);
        }
        for (const posKey in groups) {
            const isTop = posKey.startsWith('top');
            let offset = 0;
            for (const item of groups[posKey]) {
                if (isTop) {
                    item.el.style.top = (10 + offset) + 'px';
                    item.el.style.bottom = '';
                } else {
                    item.el.style.bottom = (10 + offset) + 'px';
                    item.el.style.top = '';
                }
                offset += item.el.offsetHeight + 4;
            }
        }
    }

    /** 生成固定位置消息（Guard/SC），支持同位置堆叠 */
    private spawnFixed(item: DanmakuEntry, t: number) {
        const el = document.createElement('div');
        el.style.position = 'absolute';
        el.style.whiteSpace = 'normal';
        el.style.wordBreak = 'break-all';
        el.style.fontWeight = 'bold';
        el.style.padding = '4px 12px';
        el.style.borderRadius = '4px';
        el.style.fontSize = (DANMAKU_FONT_SIZE - 2) + 'px';
        el.style.lineHeight = (DANMAKU_FONT_SIZE + 2) + 'px';
        el.style.textShadow = '1px 1px 2px rgba(0,0,0,0.6)';
        el.style.pointerEvents = 'none';
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '1';
        el.textContent = item.text;

        const fadeOutAt = item.end - 0.5;

        // 根据 {\an} 值确定位置
        const isTop = item.align === 5 || item.align === 7;
        const isRight = item.align === 3 || item.align === 7;
        const posKey = (isTop ? 'top' : 'bottom') + '-' + (isRight ? 'right' : 'left');

        // 计算同位置已有消息的总高度（用于堆叠偏移）
        let stackOffset = 0;
        for (const f of this.fixedEls) {
            if (f.posKey === posKey) {
                stackOffset += f.el.offsetHeight + 4; // 4px 间距
            }
        }

        // 设置位置
        if (isTop) {
            el.style.top = (10 + stackOffset) + 'px';
        } else {
            el.style.bottom = (10 + stackOffset) + 'px';
        }
        if (isRight) {
            el.style.right = '10px';
        } else {
            el.style.left = '10px';
        }

        // 背景色与 ASS 保持一致
        if (item.style === 'SuperChat') {
            el.style.background = 'rgba(20,165,0,0.37)';
        } else {
            el.style.background = 'rgba(255,128,0,0.50)';
        }
        el.style.color = item.color;
        el.style.maxWidth = '60%';

        this.overlay.appendChild(el);
        this.fixedEls.push({ el, endTime: item.end, posKey });

        const fadeTimer = setTimeout(() => {
            el.style.opacity = '0';
        }, Math.max(0, (fadeOutAt - t) * 1000));

        const origRemove = el.remove.bind(el);
        el.remove = () => {
            clearTimeout(fadeTimer);
            origRemove();
        };
    }
}

// ==================== 组件 ====================

type CurrentFolderFile = {
    is_folder: boolean;
    name: string;
    last_modified: number;
    size: number;
    subtitle_file?: string;
}

const FileList: React.FC = () => {
    const navigate = useNavigate();
    // 使用 "*" 通配符捕获的路径参数
    const params = useParams();
    // 确保从 URL 获取的路径参数是解码后的原始字符串
    const pathParam = decodeURIComponent(params["*"] || "");

    const [currentFolderFiles, setCurrentFolderFiles] = useState<CurrentFolderFile[]>([]);
    const [sortedInfo, setSortedInfo] = useState<any>({});
    const [isPlayerVisible, setIsPlayerVisible] = useState(false);
    const [currentPlayingName, setCurrentPlayingName] = useState("");
    const artRef = useRef<Artplayer | null>(null);
    const danmakuRef = useRef<DanmakuRenderer | null>(null);

    // 重命名相关状态
    const [isRenameModalVisible, setIsRenameModalVisible] = useState(false);
    const [renameTarget, setRenameTarget] = useState<CurrentFolderFile | null>(null);
    const [newName, setNewName] = useState("");
    const inputRef = useRef<any>(null);

    // 批量操作相关状态
    const [selectedRowKeys, setSelectedRowKeys] = useState<any[]>([]);
    const [isBatchRenameModalVisible, setIsBatchRenameModalVisible] = useState(false);
    const [batchFind, setBatchFind] = useState("");
    const [batchReplace, setBatchReplace] = useState("");

    // 当弹窗打开时，自动聚焦到输入框
    useEffect(() => {
        if (isRenameModalVisible) {
            setTimeout(() => {
                inputRef.current?.focus?.({
                    cursor: 'end',
                });
            }, 100);
        }
    }, [isRenameModalVisible]);

    // 清空选择
    useEffect(() => {
        setSelectedRowKeys([]);
    }, [pathParam]);

    const requestFileList = useCallback((path: string = "") => {
        api.getFileList(encodePath(path))
            .then((rsp: any) => {
                if (rsp?.files) {
                    setCurrentFolderFiles(rsp.files);
                    setSortedInfo(path ? {
                        order: "descend",
                        columnKey: "last_modified",
                    } : {
                        order: "ascend",
                        columnKey: "name"
                    });
                }
            });
    }, []);

    useEffect(() => {
        requestFileList(pathParam);
    }, [pathParam, requestFileList]);

    const hidePlayer = useCallback(() => {
        if (danmakuRef.current) {
            danmakuRef.current.stop();
            danmakuRef.current = null;
        }
        if (artRef.current) {
            artRef.current.destroy(true);
            artRef.current = null;
        }
        setIsPlayerVisible(false);
        setCurrentPlayingName("");
    }, []);

    // 监听 ESC 键退出播放
    useEffect(() => {
        if (!isPlayerVisible) return;

        const handleEsc = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                hidePlayer();
            }
        };
        window.addEventListener("keydown", handleEsc);
        return () => {
            window.removeEventListener("keydown", handleEsc);
        };
    }, [isPlayerVisible, hidePlayer]);

    const handleChange = (pagination: any, filters: any, sorter: any) => {
        setSortedInfo(sorter);
    };

    /**
     * 对路径进行 URL 编码，用于 API 请求和资源定位。
     */
    const encodePath = (path: string): string => {
        if (!path) return "";
        return path.split("/").map(p => encodeURIComponent(p)).join("/");
    };

    /**
     * 对路径进行双重 URL 编码，专门用于 HashRouter 导航。
     * 因为 HashRouter 会将路径中的第一个 # 视为路由分隔符，
     * 双重编码可以将 # 转义为 %2523，避免冲突。
     */
    const encodePathForNav = (path: string): string => {
        if (!path) return "";
        return path.split("/").map(p => encodeURIComponent(encodeURIComponent(p))).join("/");
    };

    const showBatchRenameModal = () => {
        setBatchFind("");
        setBatchReplace("");
        setIsBatchRenameModalVisible(true);
    };

    const showRenameModal = (record: CurrentFolderFile, e: React.MouseEvent) => {
        e.stopPropagation();
        setRenameTarget(record);
        // 如果是文件，提取不含后缀的文件名
        let baseName = record.name;
        if (!record.is_folder) {
            const lastDotIndex = record.name.lastIndexOf('.');
            if (lastDotIndex !== -1) {
                baseName = record.name.substring(0, lastDotIndex);
            }
        }
        setNewName(baseName);
        setIsRenameModalVisible(true);
    };

    const handleRename = () => {
        if (!renameTarget || !newName.trim()) return;
        let fullOldPath = renameTarget.name;
        if (pathParam) {
            fullOldPath = pathParam + "/" + renameTarget.name;
        }

        api.renameFile(encodePath(fullOldPath), newName.trim())
            .then((rsp: any) => {
                if (rsp.data === "OK") {
                    message.success("重命名成功");
                    setIsRenameModalVisible(false);
                    requestFileList(pathParam);
                } else {
                    message.error(rsp.err_msg || "重命名失败");
                }
            })
            .catch(err => message.error("重命名失败: " + err));
    };

    const handleDelete = (record: CurrentFolderFile) => {
        let fullPath = record.name;
        if (pathParam) {
            fullPath = pathParam + "/" + record.name;
        }

        api.deleteFile(encodePath(fullPath))
            .then((rsp: any) => {
                if (rsp.data === "OK") {
                    message.success("删除成功");
                    requestFileList(pathParam);
                } else {
                    message.error(rsp.err_msg || "删除失败");
                }
            })
            .catch(err => message.error("删除失败: " + err));
    };

    const handleBatchDelete = () => {
        if (selectedRowKeys.length === 0) return;
        const paths = selectedRowKeys.map(key => {
            const fileName = key.toString();
            return pathParam ? `${pathParam}/${fileName}` : fileName;
        });

        api.batchDeleteFiles(paths)
            .then((rsp: any) => {
                const results = rsp.data as any[];
                const successCount = results.filter(r => r.success).length;
                const failCount = results.length - successCount;
                if (failCount === 0) {
                    message.success(`成功删除 ${successCount} 个项目`);
                } else {
                    message.warning(`操作完成。成功: ${successCount}, 失败: ${failCount}`);
                    // 打印详细错误到控制台或通知
                    results.filter(r => !r.success).forEach(r => console.error(`删除失败 [${r.path}]: ${r.message}`));
                }
                setSelectedRowKeys([]);
                requestFileList(pathParam);
            })
            .catch(err => message.error("批量删除请求失败: " + err));
    };

    const handleBatchRename = () => {
        if (selectedRowKeys.length === 0 || !batchFind.trim()) return;
        const paths = selectedRowKeys.map(key => {
            const fileName = key.toString();
            return pathParam ? `${pathParam}/${fileName}` : fileName;
        });

        api.batchRenameFiles(paths, batchFind, batchReplace)
            .then((rsp: any) => {
                const results = rsp.data as any[];
                let successCount = 0;
                let skipCount = 0;
                let failCount = 0;
                let failMessages: string[] = [];

                results.forEach(r => {
                    if (r.success) {
                        if (r.message === "无需更改") skipCount++;
                        else successCount++;
                    } else {
                        failCount++;
                        failMessages.push(`${r.path}: ${r.message}`);
                    }
                });

                if (failCount === 0) {
                    message.success(`重命名完成。成功: ${successCount}, 无需更改: ${skipCount}`);
                } else {
                    message.warning(`重命名部分完成。成功: ${successCount}, 失败: ${failCount}`);
                    Modal.error({
                        title: '批量重命名部分失败',
                        content: (
                            <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                                {failMessages.map((msg, i) => <div key={i} style={{ color: 'red', fontSize: '12px' }}>{msg}</div>)}
                            </div>
                        ),
                    });
                }
                setIsBatchRenameModalVisible(false);
                setSelectedRowKeys([]);
                requestFileList(pathParam);
            })
            .catch(err => message.error("批量重命名请求失败: " + err));
    };

    const onRowClick = (record: CurrentFolderFile) => {
        // 保持使用原始字符串进行拼接
        let fullPath = record.name;
        if (pathParam) {
            fullPath = pathParam + "/" + record.name;
        }

        if (record.is_folder) {
            // 仅在跳转时进行编码
            navigate("/fileList/" + encodePathForNav(fullPath));
        } else {
            setCurrentPlayingName(record.name);
            setIsPlayerVisible(true);
            // 使用 setTimeout 确保 DOM 已更新
            setTimeout(() => {
                if (artRef.current) {
                    artRef.current.destroy(true);
                }

                const art = new Artplayer({
                    container: '#art-container',
                    url: `files/${encodePath(fullPath)}`,
                    title: record.name,
                    volume: 0.7,
                    autoplay: true,
                    pip: true,
                    setting: true,
                    playbackRate: true,
                    aspectRatio: true,
                    flip: true,
                    autoSize: true,
                    autoMini: true,
                    mutex: true,
                    miniProgressBar: true,
                    backdrop: true,
                    fullscreen: true,
                    fullscreenWeb: true,
                    lang: 'zh-cn',
                    customType: {
                        flv: function (video, url, art) {
                            if (mpegtsjs.isSupported()) {
                                const flvPlayer = mpegtsjs.createPlayer({
                                    type: "flv",
                                    url: url,
                                    hasVideo: true,
                                    hasAudio: true,
                                }, {});
                                flvPlayer.attachMediaElement(video);
                                flvPlayer.load();
                                art.on('destroy', () => {
                                    flvPlayer.destroy();
                                });
                            } else {
                                art.notice.show = "不支持播放格式: flv";
                            }
                        },
                        ts: function (video, url, art) {
                            if (mpegtsjs.isSupported()) {
                                const tsPlayer = mpegtsjs.createPlayer({
                                    type: "mpegts",
                                    url: url,
                                    hasVideo: true,
                                    hasAudio: true,
                                }, {});
                                tsPlayer.attachMediaElement(video);
                                tsPlayer.load();
                                art.on('destroy', () => {
                                    tsPlayer.destroy();
                                });
                            } else {
                                art.notice.show = "不支持播放格式: mpegts";
                            }
                        },
                    },
                });
                artRef.current = art;

                // 弹幕渲染集成
                if (record.subtitle_file) {
                    const assUrl = `files/${encodePath(fullPath).replace(/\.[^.]+$/, '.ass')}`;
                    art.on('ready', () => {
                        fetch(assUrl)
                            .then(r => r.ok ? r.text() : Promise.reject())
                            .then(text => {
                                const { items, scrollTime } = parseAss(text);
                                if (items.length === 0) return;

                                // 找到 Artplayer 内部容器，将覆盖层插入其中（和 video 同级）
                                const artContainer = document.getElementById('art-container');
                                if (!artContainer) return;
                                // Artplayer 在 #art-container 内创建 .art-video-player
                                const artInner = artContainer.querySelector('.art-video-player') as HTMLElement || artContainer;
                                artInner.style.position = 'relative';
                                const overlay = document.createElement('div');
                                overlay.className = 'danmaku-overlay';
                                artInner.appendChild(overlay);

                                const renderer = new DanmakuRenderer(overlay, art.video, items, scrollTime);
                                danmakuRef.current = renderer;
                                renderer.start();

                                // 拖拽进度条时跳转弹幕
                                art.on('video:seeked', () => {
                                    renderer.seek(art.video.currentTime);
                                });
                            })
                            .catch(() => { /* 没有 ASS 文件或加载失败，静默忽略 */ });
                    });
                }

                art.on('destroy', () => {
                    if (danmakuRef.current) {
                        danmakuRef.current.stop();
                        danmakuRef.current = null;
                    }
                });
            }, 0);
        }
    };

    const renderParentFolderBar = (): JSX.Element => {
        const rootFolderName = "输出文件路径";
        let currentPath = "/fileList";
        const folders = pathParam?.split("/").filter(Boolean) || [];

        const breadcrumbItems = [
            {
                key: 'root',
                title: <Link to={currentPath} onClick={hidePlayer}>{rootFolderName}</Link>
            },
            ...folders.map((v: string) => {
                currentPath += "/" + encodeURIComponent(encodeURIComponent(v));
                return {
                    key: v,
                    title: <Link to={currentPath} onClick={hidePlayer}>{v}</Link>
                };
            })
        ];

        // @ts-ignore
        return <Breadcrumb items={breadcrumbItems} />;
    };

    const renderCurrentFolderFileList = (): JSX.Element => {
        const currentSortedInfo = sortedInfo || {};
        const columns: any[] = [{
            title: "文件名",
            dataIndex: "name",
            key: "name",
            sorter: (a: CurrentFolderFile, b: CurrentFolderFile) => {
                if (a.is_folder === b.is_folder) {
                    return a.name.localeCompare(b.name);
                } else {
                    return a.is_folder ? -1 : 1;
                }
            },
            sortOrder: currentSortedInfo.columnKey === "name" && currentSortedInfo.order,
            render: (text: string, record: CurrentFolderFile) => {
                return (
                    <div className="file-name-cell">
                        {record.is_folder ? <FolderOutlined style={{ color: '#1890ff', fontSize: '16px' }} /> : <FileOutlined style={{ fontSize: '16px' }} />}
                        <span className="name-text">{record.name}</span>
                        {record.subtitle_file && (
                            <Tooltip title={`弹幕字幕: ${record.subtitle_file}`}>
                                <span style={{ marginLeft: 6, fontSize: 11, color: '#1890ff', background: '#e6f4ff', padding: '1px 6px', borderRadius: 4, cursor: 'default' }}>
                                    弹幕
                                </span>
                            </Tooltip>
                        )}
                    </div>
                );
            }
        }, {
            title: "文件大小",
            dataIndex: "size",
            key: "size",
            width: 120,
            sorter: (a: CurrentFolderFile, b: CurrentFolderFile) => a.size - b.size,
            sortOrder: currentSortedInfo.columnKey === "size" && currentSortedInfo.order,
            render: (text: number, record: CurrentFolderFile) => {
                if (record.is_folder) {
                    return "-";
                } else {
                    return Utils.byteSizeToHumanReadableFileSize(record.size);
                }
            },
        }, {
            title: "最后修改时间",
            dataIndex: "last_modified",
            key: "last_modified",
            width: 180,
            sorter: (a: CurrentFolderFile, b: CurrentFolderFile) => a.last_modified - b.last_modified,
            sortOrder: currentSortedInfo.columnKey === "last_modified" && currentSortedInfo.order,
            render: (text: number) => Utils.timestampToHumanReadable(text),
        }, {
            title: "操作",
            key: "action",
            width: 200,
            render: (text: any, record: CurrentFolderFile) => (
                <Space size="small" onClick={(e) => e.stopPropagation()}>
                    <Button
                        type="link"
                        size="small"
                        // @ts-ignore
                        icon={<EditOutlined />}
                        onClick={(e) => showRenameModal(record, e)}
                        className="action-btn"
                    >
                        重命名
                    </Button>
                    <Popconfirm
                        title={`确定要删除${record.is_folder ? '文件夹' : '文件'} "${record.name}" 吗？`}
                        onConfirm={() => handleDelete(record)}
                        okText="确定"
                        cancelText="取消"
                        // @ts-ignore
                        okButtonProps={{ danger: true }}
                    >
                        <Button
                            type="link"
                            size="small"
                            danger
                            // @ts-ignore
                            icon={<DeleteOutlined />}
                            onClick={(e) => e.stopPropagation()}
                            className="action-btn danger"
                        >
                            删除
                        </Button>
                    </Popconfirm>
                </Space>
            )
        }];

        const onSelectChange = (newSelectedRowKeys: any[]) => {
            setSelectedRowKeys(newSelectedRowKeys);
        };

        const rowSelection = {
            selectedRowKeys,
            onChange: onSelectChange,
        };

        return (<Table
            rowSelection={rowSelection}
            columns={columns}
            dataSource={currentFolderFiles}
            rowKey="name"
            onChange={handleChange}
            pagination={{ pageSize: 50 }}
            onRow={(record) => ({
                onClick: () => onRowClick(record)
            })}
            scroll={{ x: 'max-content' }}
            rowClassName={() => "file-table-row"}
        />);
    };

    const renderArtPlayer = () => {
        return (
            <div className="player-wrapper">
                <div className="player-header">
                    <div className="playing-title" title={currentPlayingName}>
                        正在播放: {currentPlayingName}
                    </div>
                    <div className="close-btn" onClick={hidePlayer} title="退出播放 (Esc)">
                        <CloseOutlined />
                    </div>
                </div>
                <div id="art-container"></div>
            </div>
        );
    };

    return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>{renderParentFolderBar()}</div>
                {selectedRowKeys.length > 0 && (
                    <Space>
                        <span style={{ fontSize: '14px', color: '#8c8c8c' }}>已选择 {selectedRowKeys.length} 项</span>
                        <Button type="primary" size="small" onClick={showBatchRenameModal}>
                            批量重命名
                        </Button>
                        <Popconfirm
                            title={`确定要删除选中的 ${selectedRowKeys.length} 个项目吗？`}
                            onConfirm={handleBatchDelete}
                            okText="确定"
                            cancelText="取消"
                            // @ts-ignore
                            okButtonProps={{ danger: true }}
                        >
                            {/* @ts-ignore */}
                            <Button danger size="small">
                                批量删除
                            </Button>
                        </Popconfirm>
                        <Button size="small" onClick={() => setSelectedRowKeys([])}>取消选择</Button>
                    </Space>
                )}
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
                {isPlayerVisible ? renderArtPlayer() : renderCurrentFolderFileList()}
            </div>

            {/* @ts-ignore */}
            <Modal
                title={`重命名 ${renameTarget?.is_folder ? '文件夹' : '文件'}`}
                open={isRenameModalVisible}
                onOk={handleRename}
                onCancel={() => setIsRenameModalVisible(false)}
                okText="确定"
                cancelText="取消"
                destroyOnClose
            >
                <div>
                    <div style={{ marginBottom: 8 }}>请输入新名称（后缀会自动保留）：</div>
                    <Input
                        ref={inputRef}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        placeholder="请输入新名称"
                        onPressEnter={handleRename}
                        autoFocus
                    />
                    {!renameTarget?.is_folder && renameTarget?.name.includes('.') && (
                        <div style={{ marginTop: 8, color: '#8c8c8c', fontSize: '12px' }}>
                            当前后缀: {renameTarget.name.substring(renameTarget.name.lastIndexOf('.'))}
                        </div>
                    )}
                </div>
            </Modal>
            {/* @ts-ignore */}
            <Modal
                title="批量重命名 (查找替换)"
                open={isBatchRenameModalVisible}
                onOk={handleBatchRename}
                onCancel={() => setIsBatchRenameModalVisible(false)}
                okText="开始替换"
                cancelText="取消"
                destroyOnClose
            >
                <div>
                    <div style={{ marginBottom: 16 }}>
                        <div style={{ marginBottom: 8 }}>查找内容:</div>
                        <Input
                            value={batchFind}
                            onChange={(e) => setBatchFind(e.target.value)}
                            placeholder="输入要查找的字符串"
                            autoComplete="off"
                        />
                    </div>
                    <div>
                        <div style={{ marginBottom: 8 }}>替换为:</div>
                        <Input
                            value={batchReplace}
                            onChange={(e) => setBatchReplace(e.target.value)}
                            placeholder="输入替换后的字符串"
                            autoComplete="off"
                        />
                    </div>
                    <div style={{ marginTop: 16, color: '#8c8c8c', fontSize: '12px' }}>
                        * 此操作将对所有选中的文件执行查找替换。文件后缀将被自动保护。
                        <br />* 被其他程序占用的文件将被自动跳过。
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default FileList;
