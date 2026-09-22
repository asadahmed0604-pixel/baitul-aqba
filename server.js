import { createApp } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const { server, bootstrap } = createApp({
  dataDir: process.env.DATA_DIR,
  uploadsDir: process.env.UPLOADS_DIR,
  secureCookies: process.env.SECURE_COOKIES === '1',
});

server.listen(port, host, () => {
  console.log(`Bait ul Aqba donation system running at http://localhost:${port}`);
  console.log(`  Donor portal:      http://localhost:${port}/donor`);
  console.log(`  Management portal: http://localhost:${port}/admin`);
  if (bootstrap) {
    console.log('\nFirst run: a management account was created.');
    console.log(`  Email:    ${bootstrap.email}`);
    console.log(`  Password: ${bootstrap.password}`);
    console.log('  Sign in and change this password under Settings.\n');
  }
});
