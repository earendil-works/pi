// Override only window.location.host to be empty so api.ts falls back to 127.0.0.1:8741.
// Keep origin valid so react-router (NavLink) can construct URLs via new URL(path, origin).
const fakeLocation = {
  host: "",
  hostname: "",
  href: "",
  origin: "http://localhost:3000", // valid origin required by react-router's createURL
  pathname: "",
  port: "",
  protocol: "http:",
  search: "",
  toString: () => fakeLocation.href,
  toJSON: () => fakeLocation.href,
};
Object.defineProperty(window, "location", {
  value: fakeLocation,
  writable: true,
  configurable: true,
});