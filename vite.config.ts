import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ command, mode }) => {
  const environment = loadEnv(mode, '.', 'VITE_');
  const apiBase = environment.VITE_API_BASE_URL?.trim() || (mode === 'pages' ? null : command === 'serve' ? 'http://127.0.0.1:8787/api' : '/api');
  const url = new URL(apiBase || '/api', 'https://same-origin.invalid');
  if (apiBase && ((apiBase !== '/api' && !/^https?:\/\//.test(apiBase)) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/api')) {
    throw new Error('VITE_API_BASE_URL 必须为 /api 或 http(s)://API域名/api，不含账号、查询参数或邀请令牌');
  }
  const connectSource = !apiBase || apiBase === '/api' ? "'self'" : `'self' ${url.origin}`;

  return {
    root: 'web',
    base: './',
    envDir: '..',
    define: { __API_BASE_URL__: JSON.stringify(apiBase?.replace(/\/$/, '') ?? null) },
    server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
    build: { outDir: '../dist', emptyOutDir: true, sourcemap: false },
    plugins: [{
      name: 'self-hosted-content-policy',
      transformIndexHtml() {
        if (command === 'serve') return [];
        return [{ tag: 'meta', attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src ${connectSource}; object-src 'none'; base-uri 'self'; form-action 'self'`,
        }, injectTo: 'head' }];
      },
    }],
  };
});
