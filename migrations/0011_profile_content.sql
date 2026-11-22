-- 个人展示内容。单行表，文字由管理员填写；受邀者只会通过带令牌的 /api/invite
-- 按该邀请已授权的模块取得对应字段，静态文件和首页不含这些内容。
-- 兼容曾在个人展示分支应用同一表结构的数据库，保留已经填写的内容。
CREATE TABLE IF NOT EXISTS profile_content (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 40),
  profile TEXT NOT NULL DEFAULT '' CHECK (length(profile) <= 2000),
  tracks TEXT NOT NULL DEFAULT '' CHECK (length(tracks) <= 2000),
  investments TEXT NOT NULL DEFAULT '' CHECK (length(investments) <= 2000),
  contact TEXT NOT NULL DEFAULT '' CHECK (length(contact) <= 2000),
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO profile_content (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
