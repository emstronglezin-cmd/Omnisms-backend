const cron = require('node-cron');
const { exec } = require('child_process');

const deployToRender = () => {
  console.log('Starting deployment to Render...');
  exec('git push render main', (error, stdout, stderr) => {
    if (error) {
      console.error(`Deployment error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Deployment stderr: ${stderr}`);
      return;
    }
    console.log(`Deployment stdout: ${stdout}`);
  });
};

// Keep-alive ping every 5 minutes
cron.schedule('*/5 * * * *', () => {
  console.log('Sending keep-alive ping...');
  exec('curl https://your-render-app-url.com', (error, stdout, stderr) => {
    if (error) {
      console.error(`Keep-alive error: ${error.message}`);
    }
  });
});

deployToRender();