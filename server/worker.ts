import { createApi } from './app.js';
import { refreshCalendars } from './calendar-sources.js';
import type { Environment } from './db.js';

const app = createApi();
export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Environment) {
    await refreshCalendars(env);
  },
};
