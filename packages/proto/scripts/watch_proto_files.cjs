const fs = require("fs");

const { exec } = require("child_process");

const debounce = require("lodash.debounce");

const path = require("path");

const currentDirectory = process.cwd();

const schemaDirectory = path.join(currentDirectory, "schema");

const buildCommand = "bun run build";

const handleFileChange = debounce((eventType, filename) => {
  console.log(`Detected ${eventType} in ${filename}, running build command...`);
  exec(buildCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error: ${error.message}`);
    } else if (stderr) {
      console.error(`Stderr: ${stderr}`);
    } else if (stdout) {
      console.log(`Stdout: ${stdout}`);
    }

    console.log("Done.");
  });
}, 1000);

function watchProtoDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, (eventType, filename) => {
    if (filename && filename.endsWith(".proto")) {
      handleFileChange(eventType, filename);
    }
  });
}

watchProtoDir(currentDirectory);

watchProtoDir(schemaDirectory);

console.log(`Watching ${currentDirectory} and ${schemaDirectory} for changes...`);
