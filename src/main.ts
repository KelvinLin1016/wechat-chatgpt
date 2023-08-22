import { WechatyBuilder } from "wechaty";
import QRCode from "qrcode";
import { ChatGPTBot, GinkgoBot } from "./bot.js";
import { config } from "./config.js";
import { BotType, CustomerServiceContact } from "./constant.js";
// const chatBot = new ChatGPTBot('ChatGPT', BotType.Default);
const chatBot = new GinkgoBot("Ginkgo Customer Service", BotType.GinkgoCustomerService);

const bot = WechatyBuilder.build({
  name: "wechat-assistant", // generate xxxx.memory-card.json and save login data for the next login
  puppet: "wechaty-puppet-wechat",
  puppetOptions: {
    uos: true
  }
});
async function main() {
  const initializedAt = Date.now()
  bot
    .on("scan", async (qrcode, status) => {
      const url = `https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`;
      console.log(`Scan QR Code to login: ${status}\n${url}`);
      console.log(
        await QRCode.toString(qrcode, { type: "terminal", small: true })
      );
    })
    .on("login", async (user) => {
      // chatGPTBot.setBotName(user.name());
      console.log(`User ${user} logged in`);
      console.log(`Bot: ${user.name()}`);
      console.log(`私聊触发关键词: ${config.chatPrivateTriggerKeyword}`);
      console.log(`是否允许群聊： ${!(config.disableGroupMessage)}`);
      console.log(`已设置 ${config.blockWords.length} 个聊天关键词屏蔽. ${config.blockWords}`);
      console.log(`已设置 ${config.chatgptBlockWords.length} 个ChatGPT回复关键词屏蔽. ${config.chatgptBlockWords}`);
      
    })
    .on("message", async (message) => {
      const customerServiceContact = await bot.Contact.find({ name: CustomerServiceContact });

      if (message.date().getTime() < initializedAt) {
        return;
      }
      if (message.text().startsWith("/ping")) {
        await message.say("pong");
        return;
      }
      try {
        if (chatBot.botType == BotType.GinkgoCustomerService && customerServiceContact) {
          await chatBot.onMessage(message, customerServiceContact);
        }
        else {
          await chatBot.onMessage(message);
        }
      } catch (e) {
        console.error(e);
      }
    });
    
  

  try {
    await bot.start();

  } catch (e) {
    console.error(
      `⚠️ Bot start failed, can you log in through wechat on the web?: ${e}`
    );
  }
}
main();
