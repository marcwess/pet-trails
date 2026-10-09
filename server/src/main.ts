import { startServer } from './index.js';

startServer().then((srv) => {
  console.log(`pet-trails listening on :${srv.port}`);
});
