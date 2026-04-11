import { complete, getModel } from "@tculpepp/spi-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
