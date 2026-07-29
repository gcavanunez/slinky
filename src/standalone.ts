import packageJson from "../package.json" with { type: "json" };

const command = process.argv[2];

if (command === "-v" || command === "--version" || command === "version") {
  console.log(packageJson.version);
  process.exit(0);
}

await import("./cli.js");
