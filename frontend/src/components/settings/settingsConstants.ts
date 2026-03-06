export type SettingsSection = 'radio' | 'local' | 'database' | 'fanout' | 'statistics' | 'about';

export const SETTINGS_SECTION_ORDER: SettingsSection[] = [
  'radio',
  'local',
  'database',
  'fanout',
  'statistics',
  'about',
];

export const SETTINGS_SECTION_LABELS: Record<SettingsSection, string> = {
  radio: '📻 Radio',
  local: '🖥️ Local Configuration',
  database: '🗄️ Database & Messaging',
  fanout: '📤 MQTT & Forwarding',
  statistics: '📊 Statistics',
  about: 'About',
};
