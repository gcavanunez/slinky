import packageJson from "../package.json" with { type: "json" };

const command = process.argv[2];

if (command === "-v" || command === "--version" || command === "version") {
  console.log(packageJson.version);
  process.exit(0);
}

// Release verification hook, not part of the CLI surface. Kept here rather than
// in cli.ts so it runs against a build the same way --version does.
if (command === "--selftest") {
  const { runSelfTest } = await import("./selftest.js");
  await runSelfTest();
  process.exit(0);
}

await import("./cli.js");
