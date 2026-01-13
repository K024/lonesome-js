// Test config file for denali-cli
console.log("Hello from Denali.js config!");

// Test some standard APIs
console.log("Current timestamp:", Date.now());
console.log("Environment check:", typeof globalThis);

// Test Web API availability
console.log("fetch available:", typeof fetch, fetch.name);
console.log("URL available:", typeof URL, URL.name);
console.log("crypto available:", typeof crypto);

// Test a simple async operation
const response = await Promise.resolve("Async works!");
console.log(response);

console.log("Config executed successfully!");

const typesTest: string = "Typescript transpilation works!";
console.log(typesTest);
