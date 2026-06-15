import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Tag, Tooltip } from 'antd';
import {
  VerticalAlignBottomOutlined
} from '@ant-design/icons';
import './danmaku-panel.css';

const MAX_MESSAGES = 500;
const ITEM_HEIGHT = 32;
const OVERSCAN = 5;

export interface DanmakuMessage {
  type: 'danmaku' | 'gift' | 'super_chat' | 'guard';
  username: string;
  content: string;
  color?: number;
  timestamp: number;
  gift_name?: string;
  num?: number;
  price?: number;
  coin_type?: string;
}

interface DanmakuPanelProps {
  messages: DanmakuMessage[];
  roomName?: string;
}

// 消息类型过滤配置
const FILTER_TYPES: { key: DanmakuMessage['type']; label: string; color: string }[] = [
  { key: 'danmaku', label: '弹幕', color: '#69b1ff' },
  { key: 'gift', label: '礼物', color: '#ffc53d' },
  { key: 'super_chat', label: 'SC', color: '#ffa940' },
  { key: 'guard', label: '舰长', color: '#b37feb' },
];

const DanmakuPanel: React.FC<DanmakuPanelProps> = ({ messages, roomName }) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeFilters, setActiveFilters] = useState<Set<DanmakuMessage['type']>>(
    () => new Set(FILTER_TYPES.map(f => f.key))
  );

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(300);

  const listContainerRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);

  // 直接派生，避免 useState + useEffect 的多余渲染
  const displayMessages = useMemo(() => messages.slice(-MAX_MESSAGES), [messages]);

  // 切换过滤类型
  const toggleFilter = useCallback((type: DanmakuMessage['type']) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        // 如果只剩一个，不允许取消
        if (next.size <= 1) return prev;
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // 过滤后的消息
  const filteredMessages = useMemo(() => {
    if (activeFilters.size === FILTER_TYPES.length) return displayMessages;
    return displayMessages.filter(msg => activeFilters.has(msg.type));
  }, [displayMessages, activeFilters]);

  useEffect(() => {
    if (autoScroll && autoScrollEnabledRef.current && listContainerRef.current) {
      listContainerRef.current.scrollTop = listContainerRef.current.scrollHeight;
    }
  }, [filteredMessages, autoScroll]);

  // 容器高度监听
  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight || 300);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const h = entry.contentRect.height;
        if (h > 0) setContainerHeight(h);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    setScrollTop(container.scrollTop);
    autoScrollEnabledRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  }, []);

  const toggleAutoScroll = useCallback(() => {
    const next = !autoScroll;
    setAutoScroll(next);
    if (next) {
      autoScrollEnabledRef.current = true;
      if (listContainerRef.current) listContainerRef.current.scrollTop = listContainerRef.current.scrollHeight;
    }
  }, [autoScroll]);

  // 虚拟列表
  const totalHeight = filteredMessages.length * ITEM_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(filteredMessages.length, Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN);
  const visibleMessages = filteredMessages.slice(startIndex, endIndex);
  const offsetY = startIndex * ITEM_HEIGHT;

  const formatTime = (timestamp: number): string => new Date(timestamp * 1000).toLocaleTimeString();

  // 与 ASS 文件一致的格式化
  const formatGiftText = (msg: DanmakuMessage): string => {
    if (msg.coin_type === 'gold' && msg.price && msg.price > 0) {
      return `¥${(msg.price * (msg.num || 1) / 1000).toFixed(1)}`;
    }
    return '';
  };

  const formatGuardText = (msg: DanmakuMessage): string => {
    if (msg.price && msg.price > 0) {
      return `¥${(msg.price / 1000).toFixed(0)}`;
    }
    return '';
  };

  const renderMessage = useCallback((msg: DanmakuMessage) => {
    const timeStr = formatTime(msg.timestamp);

    switch (msg.type) {
      case 'danmaku':
        return (
          <span className="dm-line dm-danmaku">
            <span className="dm-time">{timeStr}</span>
            <span className="dm-username">{msg.username}</span>
            <span className="dm-colon">: </span>
            <Tooltip title={msg.content} placement="topLeft" overlayClassName="dm-tooltip">
              <span className="dm-content" style={msg.color ? { color: `#${msg.color.toString(16).padStart(6, '0')}` } : undefined}>
                {msg.content}
              </span>
            </Tooltip>
          </span>
        );
      case 'gift': {
        const priceText = formatGiftText(msg);
        return (
          <span className="dm-line dm-gift">
            <span className="dm-time">{timeStr}</span>
            <Tag color="gold" style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', marginRight: 4 }}>礼物{priceText ? ` ${priceText}` : ''}</Tag>
            <span className="dm-username">{msg.username}</span>
            <span> 赠送 {msg.gift_name || ''} x{msg.num}</span>
          </span>
        );
      }
      case 'super_chat':
        return (
          <span className="dm-line dm-super-chat">
            <span className="dm-time">{timeStr}</span>
            <Tag color="orange" style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', marginRight: 4 }}>SC ¥{msg.price}</Tag>
            <span className="dm-username">{msg.username}</span>
            <span>: {msg.content}</span>
          </span>
        );
      case 'guard': {
        const guardPrice = formatGuardText(msg);
        return (
          <span className="dm-line dm-guard">
            <span className="dm-time">{timeStr}</span>
            <Tag color="purple" style={{ fontSize: 11, lineHeight: '18px', padding: '0 4px', marginRight: 4 }}>
              {msg.gift_name}{guardPrice ? ` ${guardPrice}` : ''}
            </Tag>
            <span className="dm-username">{msg.username}</span>
            <span> 开通了{msg.gift_name}</span>
          </span>
        );
      }
      default:
        return (
          <span className="dm-line">
            <span className="dm-time">{timeStr}</span>
            <span className="dm-username">{msg.username}</span>
            <span>: {msg.content}</span>
          </span>
        );
    }
  }, []);

  const isAllFiltered = activeFilters.size === FILTER_TYPES.length;

  return (
    <div className="dm-panel">
      {/* 操作栏 */}
      <div className="dm-filter-bar">
        {/* 筛选按钮组 */}
        <div className="dm-filter-group">
          {FILTER_TYPES.map(f => {
            const isActive = activeFilters.has(f.key);
            return (
              <div
                key={f.key}
                className={`dm-filter-chip ${isActive ? 'active' : ''}`}
                style={isActive ? { '--chip-color': f.color } as React.CSSProperties : undefined}
                onClick={() => toggleFilter(f.key)}
              >
                <span className="dm-filter-dot" style={{ background: isActive ? f.color : undefined }} />
                <span className="dm-filter-label">{f.label}</span>
              </div>
            );
          })}
        </div>

        {/* 右侧操作 */}
        <div className="dm-actions">
          <div className={`dm-scroll-toggle ${autoScroll ? 'on' : 'off'}`} onClick={toggleAutoScroll}>
            <VerticalAlignBottomOutlined />
            <span>{autoScroll ? '滚动中' : '已暂停'}</span>
          </div>
        </div>
      </div>

      {/* 弹幕列表 */}
      <div ref={listContainerRef} className="dm-list-container" onScroll={handleScroll}>
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visibleMessages.map((msg) => (
              <div key={`${msg.timestamp}-${msg.username}-${msg.type}`} className="dm-item" style={{ height: ITEM_HEIGHT }}>
                {renderMessage(msg)}
              </div>
            ))}
          </div>
        </div>
        {filteredMessages.length === 0 && (
          <div className="dm-empty">
            {displayMessages.length === 0 ? '暂无弹幕' : '当前筛选无匹配弹幕'}
          </div>
        )}
      </div>

      {/* 状态栏 */}
      <div className="dm-status-bar">
        <span>
          {isAllFiltered ? `共 ${displayMessages.length} 条` : `已筛选 ${filteredMessages.length}/${displayMessages.length} 条`}
        </span>
        {displayMessages.length >= MAX_MESSAGES && (
          <span className="dm-limit-hint">（已达上限）</span>
        )}
        {autoScroll && (
          <span className="dm-autoscroll-hint">自动滚动中</span>
        )}
      </div>
    </div>
  );
};

export default DanmakuPanel;
