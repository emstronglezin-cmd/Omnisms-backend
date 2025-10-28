const { exec } = require('child_process');
const path = require('path');

const backupMongoDB = () => {
  const backupPath = path.join(__dirname, '../backups', `backup-${new Date().toISOString()}.gz`);
  const command = `mongodump --uri="${process.env.MONGO_URI}" --archive=${backupPath} --gzip`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Backup error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`Backup stderr: ${stderr}`);
      return;
    }
    console.log(`Backup successful: ${backupPath}`);
  });
};

backupMongoDB();