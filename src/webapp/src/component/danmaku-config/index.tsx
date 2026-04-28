import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Card, Form, Switch, InputNumber, Select, Button, message, Spin, Collapse, Tag, Popconfirm, Space
} from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import API from '../../utils/api';

const api = new API();

const DEFAULT_DANMAKU: DanmakuConfig = {
  font_size: 36,
  font_name: 'Microsoft YaHei',
  scroll_area: 'full',
  scroll_time: 10,
  resolution: '1920x1080',
  outline: 1,
  opacity: 128,
};

interface DanmakuConfig {
  font_size: number;
  font_name: string;
  scroll_area: string;
  scroll_time: number;
  resolution: string;
  outline: number;
  opacity: number;
}

interface EffectiveConfig {
  danmaku_enable: boolean;
  danmaku: DanmakuConfig;
  platform_configs?: Record<string, any>;
}

interface RoomInfo {
  live_id: string;
  url: string;
  host_name?: string;
  room_name?: string;
  platform_key?: string;
  room_config?: {
    danmaku_enable?: boolean;
    danmaku?: Partial<DanmakuConfig>;
    [key: string]: any;
  };
}

const DanmakuParamForm: React.FC<{
  initialValues?: Partial<DanmakuConfig> | null;
  globalDefaults?: DanmakuConfig;
  onSave: (values: any) => Promise<void>;
  onReset?: () => Promise<void>;
  loading?: boolean;
  showEnable?: boolean;
  danmakuEnable?: boolean;
  label?: string;
  isRoom?: boolean;
}> = ({ initialValues, globalDefaults, onSave, onReset, loading, showEnable, danmakuEnable, label, isRoom }) => {
  const [form] = Form.useForm();

  const baseDefaults = useMemo(() => globalDefaults || DEFAULT_DANMAKU, [globalDefaults]);

  useEffect(() => {
    form.setFieldsValue({
      danmaku_enable: danmakuEnable ?? false,
      danmaku: {
        ...baseDefaults,
        ...initialValues,
      },
    });
  }, [initialValues, danmakuEnable, form, baseDefaults]);

  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      await onSave(values);
      message.success(`${label || '弹幕'}配置已保存`);
    } catch (error: any) {
      if (error?.errorFields) {
        message.error('表单校验失败，请检查输入项');
      } else {
        message.error('保存失败: ' + (error?.message || '未知错误'));
      }
    }
  };

  const handleReset = async () => {
    if (isRoom && onReset) {
      // Room: clear override, inherit from global
      await onReset();
    } else {
      // Global: reset to hardcoded defaults and save
      form.setFieldsValue({
        danmaku_enable: false,
        danmaku: { ...DEFAULT_DANMAKU },
      });
      try {
        await onSave({
          danmaku_enable: false,
          danmaku: { ...DEFAULT_DANMAKU },
        });
        message.success('已恢复默认配置');
      } catch (error: any) {
        message.error('恢复默认失败: ' + (error?.message || '未知错误'));
      }
    }
  };

  return (
    <Form form={form} layout="vertical">
      {showEnable && (
        <Form.Item label="录制弹幕" name="danmaku_enable" valuePropName="checked">
          <Switch />
        </Form.Item>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
        <Form.Item
          label={<span>字体大小 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>弹幕文字的像素大小，12~120</span></span>}
          name={['danmaku', 'font_size']}
          rules={[{ required: true, message: '必填' }, { type: 'number', min: 12, max: 120, message: '12~120' }]}>
          <InputNumber min={12} max={120} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label={<span>字体名称 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>播放器需安装该字体才能正确显示</span></span>}
          name={['danmaku', 'font_name']}
          rules={[{ required: true, message: '不能为空' }]}>
          <Select style={{ width: '100%' }} showSearch options={[
            { label: '微软雅黑 (Microsoft YaHei)', value: 'Microsoft YaHei' },
            { label: '黑体 (SimHei)', value: 'SimHei' },
            { label: '宋体 (SimSun)', value: 'SimSun' },
            { label: '楷体 (KaiTi)', value: 'KaiTi' },
            { label: '仿宋 (FangSong)', value: 'FangSong' },
            { label: '思源黑体 (Source Han Sans)', value: 'Source Han Sans' },
            { label: '思源宋体 (Source Han Serif)', value: 'Source Han Serif' },
            { label: '等线 (DengXian)', value: 'DengXian' },
            { label: '霞鹜文楷 (LXGW WenKai)', value: 'LXGW WenKai' },
            { label: 'Arial', value: 'Arial' },
            { label: 'Arial Black', value: 'Arial Black' },
            { label: 'Consolas', value: 'Consolas' },
            { label: 'Segoe UI', value: 'Segoe UI' },
          ]} />
        </Form.Item>
        <Form.Item
          label={<span>滚动区域 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>弹幕在屏幕上的滚动范围</span></span>}
          name={['danmaku', 'scroll_area']}>
          <Select options={[
            { label: '全屏', value: 'full' },
            { label: '顶部半屏', value: 'top' },
            { label: '底部半屏', value: 'bottom' },
          ]} />
        </Form.Item>
        <Form.Item
          label={<span>滚动时间 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>弹幕滚过整屏的秒数，越短越快</span></span>}
          name={['danmaku', 'scroll_time']}
          rules={[{ required: true, message: '必填' }, { type: 'number', min: 5, max: 20, message: '5~20' }]}>
          <InputNumber min={5} max={20} style={{ width: '100%' }} addonAfter="秒" />
        </Form.Item>
        <Form.Item
          label={<span>播放分辨率 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>ASS 字幕的画布尺寸，建议与视频分辨率一致</span></span>}
          name={['danmaku', 'resolution']}>
          <Select options={[
            { label: '1920x1080 (1080p)', value: '1920x1080' },
            { label: '1280x720 (720p)', value: '1280x720' },
            { label: '2560x1440 (2K)', value: '2560x1440' },
            { label: '3840x2160 (4K)', value: '3840x2160' },
          ]} />
        </Form.Item>
        <Form.Item
          label={<span>描边粗细 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>文字外轮廓线宽度，0 为无描边</span></span>}
          name={['danmaku', 'outline']}
          rules={[{ type: 'number', min: 0, max: 4, message: '0~4' }]}>
          <InputNumber min={0} max={4} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          label={<span>背景透明度 <span style={{ fontWeight: 400, fontSize: 12, color: '#999' }}>弹幕文字背景的不透明程度，0 完全透明，255 完全不透明</span></span>}
          name={['danmaku', 'opacity']}
          rules={[{ type: 'number', min: 0, max: 255, message: '0~255' }]}>
          <InputNumber min={0} max={255} style={{ width: '100%' }} />
        </Form.Item>
      </div>
      <Form.Item style={{ marginBottom: 0 }}>
        <Space>
          <Button type="primary" onClick={handleSave} loading={loading}>
            保存
          </Button>
          <Popconfirm
            title={isRoom ? '恢复为全局默认？' : '恢复为系统默认？'}
            description={isRoom ? '将清除房间级弹幕配置，使用全局设置' : '将重置所有弹幕参数为系统默认值'}
            onConfirm={handleReset}
            okText="确认"
            cancelText="取消"
          >
            <Button icon={<UndoOutlined />}>
              恢复默认
            </Button>
          </Popconfirm>
        </Space>
      </Form.Item>
    </Form>
  );
};

const DanmakuSettings: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<EffectiveConfig | null>(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [effective, platformStats] = await Promise.all([
        api.getEffectiveConfig(),
        api.getPlatformStats(),
      ]);
      setConfig(effective as EffectiveConfig);

      // Extract Bilibili rooms
      const stats = platformStats as any;
      const bilibiliRooms: RoomInfo[] = [];
      if (Array.isArray(stats?.platforms)) {
        for (const platform of stats.platforms) {
          if (platform.platform_key?.includes('bilibili') && Array.isArray(platform.rooms)) {
            for (const room of platform.rooms) {
              bilibiliRooms.push(room);
            }
          }
        }
      }
      setRooms(bilibiliRooms);
    } catch (error) {
      message.error('加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveGlobal = async (values: any) => {
    setSaving(true);
    try {
      await api.updateConfig({
        danmaku_enable: values.danmaku_enable,
        danmaku: values.danmaku,
      });
      await loadData();
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRoom = async (liveId: string, values: any) => {
    setSaving(true);
    try {
      await api.updateRoomConfigById(liveId, {
        danmaku_enable: values.danmaku_enable,
        danmaku: values.danmaku,
      });
      await loadData();
    } finally {
      setSaving(false);
    }
  };

  const handleResetRoom = async (liveId: string) => {
    setSaving(true);
    try {
      // Send null to clear room-level overrides, reverting to global inheritance
      await api.updateRoomConfigById(liveId, {
        danmaku_enable: null,
        danmaku: null,
      });
      message.success('已恢复为全局默认配置');
      await loadData();
    } catch (error: any) {
      message.error('恢复失败: ' + (error?.message || '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !config) {
    return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />;
  }

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>弹幕录制配置</h2>

      <Card title="全局设置" size="small" style={{ marginBottom: 16 }}>
        <DanmakuParamForm
          initialValues={config?.danmaku}
          danmakuEnable={config?.danmaku_enable}
          showEnable
          onSave={handleSaveGlobal}
          loading={saving}
          label="全局弹幕"
        />
      </Card>

      {rooms.length > 0 && (
        <Card title="房间设置 (哔哩哔哩)" size="small">
          <Collapse
            items={rooms.map((room) => ({
              key: room.live_id,
              label: (
                <span>
                  {room.room_config?.room_name || room.room_name || room.url}
                  {room.host_name && <Tag style={{ marginLeft: 8 }}>{room.host_name}</Tag>}
                </span>
              ),
              children: (
                <DanmakuParamForm
                  initialValues={room.room_config?.danmaku}
                  globalDefaults={config?.danmaku}
                  danmakuEnable={room.room_config?.danmaku_enable ?? config?.danmaku_enable}
                  showEnable
                  onSave={(values) => handleSaveRoom(room.live_id, values)}
                  onReset={() => handleResetRoom(room.live_id)}
                  loading={saving}
                  label={room.host_name || '房间弹幕'}
                  isRoom
                />
              ),
            }))}
          />
        </Card>
      )}
    </div>
  );
};

export default DanmakuSettings;
