-- 为路由增加「专属域名」。
--
-- 背景：/t/<slug>/ 前缀形式对纯静态 HTML 尚可，但应用发出的绝对路径
-- （/js/app.js、/api/xxx）会丢掉前缀而打到 Worker 根路径，无法工作。
-- 让每条路由可以绑定一个域名后，该域名下的请求直接以根路径交给应用，
-- 绝对路径天然正确，因此任何项目都能「接上就能跑」，无需改应用代码。
--
-- 用新迁移而不是改 0001：D1 会记录已执行过的迁移文件名，改动旧文件
-- 在本地与远端都不会重新执行，表现为「代码对了但表结构没变」。
ALTER TABLE routes ADD COLUMN hostname TEXT;

-- 部分唯一索引：允许多条路由都没有专属域名（NULL），
-- 但同一个域名不能同时指向两条路由，否则分发结果将取决于查询顺序。
CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_hostname ON routes (hostname)
  WHERE hostname IS NOT NULL;
