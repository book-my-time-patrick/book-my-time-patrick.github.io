try {
  const url = new URL(process.env.VITE_API_BASE_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/api' || url.hostname === 'localhost' || url.hostname.endsWith('.workers.dev') || url.hostname.endsWith('.github.io')) {
    throw new Error('INVALID_API_URL');
  }
} catch {
  console.error('请在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 设置 VITE_API_BASE_URL，例如 https://api.你的域名/api。需要自有域名。');
  process.exitCode = 1;
}
