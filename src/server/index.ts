import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "4310", 10);
const host = "127.0.0.1";

createApp().listen(port, host, () => {
  console.log(`Delta Account Scout API listening on http://${host}:${port}`);
});
