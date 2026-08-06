import React from 'react';
import { Card, Form, Switch, Select, Input, Tag, Alert } from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import TemplateBuilder, { TemplateVariable, PresetTemplate, MockStream } from '../TemplateBuilder';

interface ConfigFieldProps {
  label: string;
  description?: string;
  children: React.ReactElement;
}

// 简化版 ConfigField 组件
const ConfigField: React.FC<ConfigFieldProps> = ({ label, description, children }) => (
  <div className="config-item" style={{ marginBottom: 16 }}>
    <div className="config-item-label" style={{ marginBottom: 4, fontWeight: 500 }}>{label}</div>
    <div className="config-item-content">
      <div className="config-item-input">{children}</div>
      {description && (
        <div className="config-item-description" style={{ marginTop: 4, color: '#888', fontSize: 12 }}>
          {description}
        </div>
      )}
    </div>
  </div>
);

// 上传路径模板 - 可用变量
const UPLOAD_VARIABLES: TemplateVariable[] = [
  { key: 'Platform', label: '平台', example: 'bilibili', template: '{{ .Platform }}' },
  { key: 'HostName', label: '主播名', example: '小辞炒糍粑', template: '{{ .HostName }}' },
  { key: 'RoomName', label: '房间名', example: '中午好今天单排！', template: '{{ .RoomName }}' },
  { key: 'FileName', label: '文件名', example: '[2026-08-05][小辞炒糍粑].flv', template: '{{ .FileName }}' },
  { key: 'Date', label: '日期', example: '2026-08-05', template: '{{ now | date "2006-01-02" }}' },
  { key: 'DateTime', label: '日期时间', example: '2026-08-05 15-04-05', template: '{{ now | date "2006-01-02 15-04-05" }}' },
  { key: 'Ext', label: '扩展名', example: 'flv', template: '{{ .Ext }}' },
];

// 上传路径模板 - 预设模板
const UPLOAD_PRESETS: PresetTemplate[] = [
  {
    name: '按日期归档',
    description: '按平台/主播/日期归档',
    template: '/录播归档/{{ .Platform }}/{{ .HostName }}/{{ now | date "2006-01-02" }}/{{ .FileName }}',
  },
  {
    name: '简洁归档',
    description: '按平台/主播归档，文件名带日期',
    template: '/录播归档/{{ .Platform }}/{{ .HostName }}/{{ .RoomName }}-{{ now | date "2006-01-02" }}.{{ .Ext }}',
  },
  {
    name: '按房间归档',
    description: '按平台/主播/房间名归档',
    template: '/录播归档/{{ .Platform }}/{{ .HostName }}/{{ .RoomName }}/{{ .FileName }}',
  },
  {
    name: '原始文件名',
    description: '保留原始文件名，按平台/主播归档',
    template: '/录播归档/{{ .Platform }}/{{ .HostName }}/{{ .FileName }}',
  },
];

// 模拟数据（用于预览）
const MOCK_DATA: MockStream[] = [
  {
    platform: 'bilibili',
    platformCN: '哔哩哔哩',
    hostName: '小辞炒糍粑',
    rooms: [
      { roomName: '中午好今天单排！', date: '2026-08-05', time: '12-00-00' },
      { roomName: '晚上吃鸡', date: '2026-08-05', time: '20-00-00' },
      { roomName: '中午好今天单排！', date: '2026-08-06', time: '12-00-00' },
    ],
  },
  {
    platform: 'bilibili',
    platformCN: '哔哩哔哩',
    hostName: '老番茄',
    rooms: [
      { roomName: '杂谈闲聊', date: '2026-08-05', time: '19-00-00' },
      { roomName: '杂谈闲聊', date: '2026-08-07', time: '19-00-00' },
    ],
  },
  {
    platform: 'douyu',
    platformCN: '斗鱼',
    hostName: '一条小团团',
    rooms: [
      { roomName: '团团的直播间', date: '2026-08-05', time: '21-00-00' },
      { roomName: '团团的直播间', date: '2026-08-06', time: '21-00-00' },
    ],
  },
];

// 渲染上传路径模板
const renderUploadTemplate = (template: string, stream: MockStream, room: MockStream['rooms'][0]): string => {
  const fileName = `[${room.date} ${room.time}][${stream.hostName}][${room.roomName}].flv`;
  let path = template;
  path = path.replace(/\{\{ ?\.Platform ?\}\}/g, stream.platform);
  path = path.replace(/\{\{ ?\.HostName ?\}\}/g, stream.hostName);
  path = path.replace(/\{\{ ?\.RoomName ?\}\}/g, room.roomName);
  path = path.replace(/\{\{ ?\.FileName ?\}\}/g, fileName);
  path = path.replace(/\{\{ ?\.Ext ?\}\}/g, 'flv');
  path = path.replace(/\{\{ ?now \| date "2006-01-02" ?\}\}/g, room.date);
  path = path.replace(/\{\{ ?now \| date "2006-01-02 15-04-05" ?\}\}/g, `${room.date} ${room.time}`);
  return path;
};

interface CloudUploadSettingsProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any;
}

/**
 * 云盘上传设置组件
 * 用于 GlobalSettings 中显示云上传配置
 */
const CloudUploadSettings: React.FC<CloudUploadSettingsProps> = ({ config }) => {
  const isEnabled = config.on_record_finished?.cloud_upload?.enable;

  return (
    <Card
      title={<><CloudUploadOutlined /> 云盘上传</>}
      size="small"
      style={{ marginBottom: 16 }}
      extra={
        <Tag color={isEnabled ? 'green' : 'default'}>{isEnabled ? '已启用' : '未启用'}</Tag>
      }
    >
      <Alert
        message="云盘自动上传"
        description={
          <>
            录制结束后自动把视频传到网盘。需要先在{' '}
            <a
              href={`http://${window.location.hostname}:${config.openlist?.port || 5244}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              OpenList 管理页面
            </a>{' '}
            添加网盘。
          </>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />
      <ConfigField label="启用云上传" description="录制结束后自动把视频上传到网盘">
        <Form.Item name={['on_record_finished', 'cloud_upload', 'enable']} valuePropName="checked" noStyle>
          <Switch />
        </Form.Item>
      </ConfigField>
      <ConfigField label="上传时机" description="选择上传哪种文件：原始录制文件 or 处理后的最终文件">
        <Form.Item name={['on_record_finished', 'upload_timing']} noStyle>
          <Select style={{ width: 350 }} placeholder="选择上传时机">
            <Select.Option value="">处理完再上传（默认）</Select.Option>
            <Select.Option value="immediate">先上传再处理</Select.Option>
            <Select.Option value="after_process">处理完再上传</Select.Option>
          </Select>
        </Form.Item>
      </ConfigField>
      <div style={{ marginTop: -12, marginBottom: 16, marginLeft: 140, color: '#888', fontSize: 12 }}>
        <div><b>先上传再处理</b>：录制结束后立刻上传原始文件，然后再做修复、转码、烧录</div>
        <div><b>处理完再上传</b>：先做修复、转码、烧录，全部完成后再上传最终文件</div>
      </div>
      <ConfigField label="存储名称" description="你在 OpenList 里添加的网盘名称，比如 115、阿里云盘">
        <Form.Item name={['on_record_finished', 'cloud_upload', 'storage_name']} noStyle>
          <Input placeholder="例如: 115" style={{ width: 200 }} />
        </Form.Item>
      </ConfigField>

      {/* 上传路径模板 - 使用通用 TemplateBuilder 组件 */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 8, fontWeight: 500 }}>上传路径模板</div>
        <TemplateBuilder
          name={['on_record_finished', 'cloud_upload', 'upload_path_tmpl']}
          variables={UPLOAD_VARIABLES}
          presets={UPLOAD_PRESETS}
          mockData={MOCK_DATA}
          renderTemplate={renderUploadTemplate}
          placeholder="/录播归档/{{ .Platform }}/{{ .HostName }}/{{ now | date '2006-01-02' }}/{{ .FileName }}"
          showTreePreview={true}
          width={500}
        />
      </div>

      <ConfigField label="上传后删除本地文件" description="仅对「处理完再上传」生效。「先上传再处理」模式下，文件删除由转码、烧录等设置控制">
        <Form.Item name={['on_record_finished', 'cloud_upload', 'delete_after_upload']} valuePropName="checked" noStyle>
          <Switch />
        </Form.Item>
      </ConfigField>

      <Card type="inner" title="OpenList 认证配置" size="small" style={{ marginTop: 16, marginBottom: 8 }}>
        <Alert
          message="关于账号密码"
          description={<>首次启动程序时会自动生成密码并填入下方，无需手动操作。如果在 OpenList 网页改了密码，程序会自动重新登录。</>}
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
        <ConfigField label="管理员用户名" description="首次启动自动填入，一般不需要改">
          <Form.Item name={['openlist', 'username']} noStyle>
            <Input placeholder="admin" style={{ width: 200 }} />
          </Form.Item>
        </ConfigField>
        <ConfigField label="管理员密码" description="首次启动自动填入，一般不需要改">
          <Form.Item name={['openlist', 'password']} noStyle>
            <Input.Password placeholder="首次启动后自动填充" style={{ width: 200 }} />
          </Form.Item>
        </ConfigField>
      </Card>
    </Card>
  );
};

export default CloudUploadSettings;
