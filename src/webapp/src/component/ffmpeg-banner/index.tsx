import React, { useState, useEffect, useCallback } from 'react';
import { Alert, Space, Typography } from 'antd';
import {
  SyncOutlined,
  ExclamationCircleOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import { subscribeSSE, unsubscribeSSE, SSEMessage } from '../../utils/sse';
import API from '../../utils/api';
import './ffmpeg-banner.css';

const api = new API();
const { Text } = Typography;

interface FFmpegStatus {
  state: 'checking' | 'downloading' | 'ready' | 'not_found' | 'error';
  message?: string;
  source?: string;
}

const FFmpegBanner: React.FC = () => {
  const [status, setStatus] = useState<FFmpegStatus | null>(null);

  const handleSSEMessage = useCallback((message: SSEMessage) => {
    if (message.type === 'ffmpeg_status') {
      setStatus(message.data as FFmpegStatus);
    }
  }, []);

  useEffect(() => {
    // 初始化时查询当前状态
    api.getFFmpegStatus().then((res: any) => {
      if (res && res.state) {
        setStatus(res as FFmpegStatus);
      }
    }).catch(() => {});

    const subId = subscribeSSE('*', 'ffmpeg_status', handleSSEMessage);
    return () => unsubscribeSSE(subId);
  }, [handleSSEMessage]);

  // FFmpeg 已就绪或状态未知时不显示横幅
  if (!status || status.state === 'ready') {
    return null;
  }

  const renderMessage = () => {
    switch (status.state) {
      case 'checking':
        return (
          <Space>
            <SyncOutlined spin />
            <Text>正在检测 FFmpeg...</Text>
          </Space>
        );
      case 'downloading':
        return (
          <Space>
            <SyncOutlined spin />
            <Text>正在下载 FFmpeg，录制功能暂不可用...</Text>
            {status.message && <Text type="secondary">{status.message}</Text>}
          </Space>
        );
      case 'not_found':
        return (
          <Space>
            <ExclamationCircleOutlined />
            <Text>未找到 FFmpeg，录制功能不可用。</Text>
            {status.message && <Text type="secondary">{status.message}</Text>}
          </Space>
        );
      case 'error':
        return (
          <Space>
            <CloseCircleOutlined />
            <Text>FFmpeg 下载失败，录制功能不可用。</Text>
            {status.message && <Text type="secondary">{status.message}</Text>}
          </Space>
        );
      default:
        return null;
    }
  };

  const alertType = () => {
    switch (status.state) {
      case 'checking':
      case 'downloading':
        return 'info' as const;
      case 'not_found':
        return 'warning' as const;
      case 'error':
        return 'error' as const;
      default:
        return 'info' as const;
    }
  };

  const message = renderMessage();
  if (!message) return null;

  return (
    <Alert
      className="ffmpeg-banner"
      message={message}
      type={alertType()}
      banner
    />
  );
};

export default FFmpegBanner;
