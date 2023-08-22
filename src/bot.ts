import { config } from "./config.js";
import { ContactImpl, ContactInterface, RoomImpl, RoomInterface } from "wechaty/impls";
import { Message } from "wechaty";
import { FileBox } from "file-box";
import { chatgpt, dalle, whisper } from "./openai.js";
import DBUtils from "./data.js";
import { regexpEncode } from "./utils.js";
import { MessageType, BotType, CustomerServiceContact } from "./constant.js";

const SINGLE_MESSAGE_MAX_SIZE = 500;
type Speaker = RoomImpl | ContactImpl;
interface ICommand {
  name: string;
  description: string;
  exec: (talker: Speaker, text: string) => Promise<void>;
}

abstract class Bot {
  botName: string;
  botType: BotType;
  constructor(botName: string, botType: BotType) {
    this.botName = botName;
    this.botType = botType
  }

  ready = false;
  chatPrivateTriggerKeyword = config.chatPrivateTriggerKeyword;
  chatTriggerRule = config.chatTriggerRule ? new RegExp(config.chatTriggerRule) : undefined;
  disableGroupMessage = config.disableGroupMessage;

  get chatGroupTriggerRegEx(): RegExp {
    return new RegExp(`^@${regexpEncode(this.botName)}\\s`);
  }
  get chatPrivateTriggerRule(): RegExp | undefined {
    const { chatPrivateTriggerKeyword, chatTriggerRule } = this;
    let regEx = chatTriggerRule
    if (!regEx && chatPrivateTriggerKeyword) {
      regEx = new RegExp(regexpEncode(chatPrivateTriggerKeyword))
    }
    return regEx
  }
  get chatBotType(): BotType {
    return this.botType;
  }

  // Filter out the message that does not need to be processed
  abstract isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean;

  abstract onMessage(message: Message): void;

  private readonly commands: ICommand[] = [
    {
      name: "help",
      description: "显示帮助信息",
      exec: async (talker) => {
        await this.trySay(talker, "========\n" +
          "/cmd help\n" +
          "# 显示帮助信息\n" +
          "/cmd prompt <PROMPT>\n" +
          "# 设置当前会话的 prompt \n" +
          "/img <PROMPT>\n" +
          "# 根据 prompt 生成图片\n" +
          "/cmd clear\n" +
          "# 清除自上次启动以来的所有会话\n" +
          "========");
      }
    },
    {
      name: "prompt",
      description: "设置当前会话的prompt",
      exec: async (talker, prompt) => {
        if (talker instanceof RoomImpl) {
          DBUtils.setPrompt(await talker.topic(), prompt);
        } else {
          DBUtils.setPrompt(talker.name(), prompt);
        }
      }
    },
    {
      name: "clear",
      description: "清除自上次启动以来的所有会话",
      exec: async (talker) => {
        if (talker instanceof RoomImpl) {
          DBUtils.clearHistory(await talker.topic());
        } else {
          DBUtils.clearHistory(talker.name());
        }
      }
    }
  ]

  /**
   * EXAMPLE:
   *       /cmd help
   *       /cmd prompt <PROMPT>
   *       /cmd img <PROMPT>
   *       /cmd clear
   * @param contact
   * @param rawText
   */
  async command(contact: any, rawText: string): Promise<void> {
    const [commandName, ...args] = rawText.split(/\s+/);
    const command = this.commands.find(
      (command) => command.name === commandName
    );
    if (command) {
      await command.exec(contact, args.join(" "));
    }
  }

  // remove more times conversation and mention
  cleanMessage(rawText: string, privateChat: boolean = false): string {
    let text = rawText;
    const item = rawText.split("- - - - - - - - - - - - - - -");
    if (item.length > 1) {
      text = item[item.length - 1];
    }

    const { chatTriggerRule, chatPrivateTriggerRule } = this;

    if (privateChat && chatPrivateTriggerRule) {
      text = text.replace(chatPrivateTriggerRule, "")
    } else if (!privateChat) {
      text = text.replace(this.chatGroupTriggerRegEx, "")
      text = chatTriggerRule ? text.replace(chatTriggerRule, "") : text
    }
    // remove more text via - - - - - - - - - - - - - - -
    return text
  }

  async getGPTMessage(talkerName: string, text: string, botType: BotType): Promise<string> {
    let gptMessage = await chatgpt(talkerName, text, botType);
    if (gptMessage !== "") {
      DBUtils.addAssistantMessage(talkerName, gptMessage);
      return gptMessage;
    }
    return "Sorry, please try again later. 😔";
  }

  // Check if the message returned by chatgpt contains masked words]
  checkChatGPTBlockWords(message: string): boolean {
    if (config.chatgptBlockWords.length == 0) {
      return false;
    }
    return config.chatgptBlockWords.some((word) => message.includes(word));
  }

  // The message is segmented according to its size
  async trySay(
    talker: RoomInterface | ContactInterface,
    mesasge: string
  ): Promise<void> {
    const messages: Array<string> = [];
    if (this.checkChatGPTBlockWords(mesasge)) {
      console.log(`🚫 Blocked ChatGPT: ${mesasge}`);
      await talker.say("抱歉，回答无法正常显示，请换一种提问方式")
    }
    let message = mesasge;
    while (message.length > SINGLE_MESSAGE_MAX_SIZE) {
      messages.push(message.slice(0, SINGLE_MESSAGE_MAX_SIZE));
      message = message.slice(SINGLE_MESSAGE_MAX_SIZE);
    }
    messages.push(message);
    for (const msg of messages) {
      await talker.say(msg);
    }
  }

  // Check whether the ChatGPT processing can be triggered
  triggerGPTMessage(text: string, privateChat: boolean = false): boolean {
    const { chatTriggerRule } = this;
    let triggered = false;
    if (privateChat) {
      // const regEx = this.chatPrivateTriggerRule
      // triggered = regEx? regEx.test(text): true;
      // Private chat any text trigger chatgpt
      triggered = true;
    } else {
      triggered = this.chatGroupTriggerRegEx.test(text);
      // group message support `chatTriggerRule`
      if (triggered && chatTriggerRule) {
        triggered = chatTriggerRule.test(text.replace(this.chatGroupTriggerRegEx, ""))
      }
    }
    if (triggered) {
      console.log(`🎯 Triggered ChatGPT: ${text}`);
    }
    return triggered;
  }

  // Check whether the message contains the blocked words. if so, the message will be ignored. if so, return true
  checkBlockWords(message: string): boolean {
    if (config.blockWords.length == 0) {
      return false;
    }
    return config.blockWords.some((word) => message.includes(word));
  }

  abstract onPrivateMessage(talker: ContactInterface, text: string): void;


  // Group message 
  async onGroupMessage(
    talker: ContactInterface,
    text: string,
    room: RoomInterface
  ) {
    const gptMessage = await this.getGPTMessage(await room.topic(), text, this.botType);
    const result = `@${talker.name()} ${text}\n\n------\n ${gptMessage}`;
    await this.trySay(room, result);
  }

  async processAudioMessage(message: Message): Promise<string> {
    // 保存语音文件
    const fileBox = await message.toFileBox();
    let fileName = "./public/" + fileBox.name;
    await fileBox.toFile(fileName, true).catch((e) => {
      console.log("保存语音失败", e);
      return;
    });
    // Whisper
    // Whisper
    try {
      const text = await whisper("", fileName);
      message.say("您的问题是：" + text);
      console.log("识别的语音是：", text);
      return text;
    } catch (error) {
      console.log("Whisper 处理错误", error);
      return "抱歉，我不是很明白。";
    }

  }

}

export class ChatGPTBot extends Bot {
  constructor(botName: string, botType: BotType) {
    super(botName, botType);
  }

  isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      talker.self() ||
      // TODO: add doc support
      !(messageType == MessageType.Text || messageType == MessageType.Audio) ||
      talker.name() === "微信团队" ||
      // 语音(视频)消息
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // 红包消息
      text.includes("收到红包，请在手机上查看") ||
      // Transfer message
      text.includes("收到转账，请在手机上查看") ||
      // 位置消息
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg") ||
      // 新加好友信息
      text.includes("刚刚把你添加到通讯录") ||
      // System message
      text.includes("以上是打招呼的内容") ||
      // 聊天屏蔽词
      this.checkBlockWords(text)
    );
  }

  async onPrivateMessage(talker: ContactInterface, text: string) {
    const gptMessage = await this.getGPTMessage(talker.name(), text, this.botType);
    await this.trySay(talker, gptMessage);
  }


  // Private message
  async onMessage(message: Message) {
    const talker = message.talker();
    let rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const privateChat = !room;
    if (privateChat) {
      console.log(`🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
    } else {
      const topic = await room.topic()
      console.log(`🚪 Room: ${topic} 🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
    }
    if (this.isNonsense(talker, messageType, rawText)) {
      return;
    }

    // Process audio message
    if (messageType == MessageType.Audio) {
      rawText = await this.processAudioMessage(message);
    }

    // Run some specific command
    if (rawText.startsWith("/cmd ")) {
      console.log(`🤖 Command: ${rawText}`)
      const cmdContent = rawText.slice(5) // 「/cmd 」一共5个字符(注意空格)
      if (privateChat) {
        await this.command(talker, cmdContent);
      } else {
        await this.command(room, cmdContent);
      }
      return;
    }
    // 使用DallE生成图片
    if (rawText.includes("画")) {
      console.log(`🤖 Image: ${rawText}`)
      // const imgContent = rawText.slice(4)
      const imgContent = rawText;
      if (privateChat) {
        let url = await dalle(talker.name(), imgContent) as string;
        const fileBox = FileBox.fromUrl(url)
        message.say(fileBox)
      } else {
        let url = await dalle(await room.topic(), imgContent) as string;
        const fileBox = FileBox.fromUrl(url)
        message.say(fileBox)
      }
      return;
    }
    if (this.triggerGPTMessage(rawText, privateChat)) {
      if (messageType == MessageType.Audio) {
        rawText = rawText.slice(6);
      }
      const text = this.cleanMessage(rawText, privateChat);
      if (privateChat) {
        return await this.onPrivateMessage(talker, text);
      } else {
        if (!this.disableGroupMessage) {
          return await this.onGroupMessage(talker, text, room);
        } else {
          return;
        }
      }
    } else {
      return;
    }
  }
}

export class GinkgoBot extends Bot {
  constructor(botName: string, botType: BotType) {
    super(botName, botType);
  }

  isNonsense(
    talker: ContactInterface,
    messageType: MessageType,
    text: string
  ): boolean {
    return (
      talker.self() ||
      // TODO: add doc support
      !(messageType == MessageType.Text || messageType == MessageType.Audio) ||
      talker.name() === "微信团队" ||
      // 语音(视频)消息
      text.includes("收到一条视频/语音聊天消息，请在手机上查看") ||
      // 红包消息
      text.includes("收到红包，请在手机上查看") ||
      // Transfer message
      text.includes("收到转账，请在手机上查看") ||
      // 位置消息
      text.includes("/cgi-bin/mmwebwx-bin/webwxgetpubliclinkimg") ||
      // System message
      text.includes("以上是打招呼的内容") ||
      // 聊天屏蔽词
      this.checkBlockWords(text)
    );
  }

  onPrivateMessage(talker: ContactInterface, text: string): void;
  onPrivateMessage(talker: ContactInterface, text: string, customerService: ContactInterface): void;

  async onPrivateMessage(talker: ContactInterface, text: string, customerService?: ContactInterface) {
    const gptMessage = await this.getGPTMessage(talker.name(), text, this.botType);
    if (customerService && gptMessage.includes("[Joyful]")) {
      const rentalInfo = await this.getGPTMessage(talker.name(), "Only get all customer rental request info", this.botType);
      console.log(`Collected all rental info from ${talker.name()}: ${rentalInfo}`)
      await customerService.say(`Collected all rental info from ${talker.name()}: ${rentalInfo}`); // Send a message to the contact

    }
    await this.trySay(talker, gptMessage);
  }

  onMessage(message: Message): void;
  onMessage(message: Message, customerService: ContactInterface): void;

  // Private message
  async onMessage(message: Message, customerService?: ContactInterface) {
    const talker = message.talker();
    let rawText = message.text();
    const room = message.room();
    const messageType = message.type();
    const privateChat = !room;

    if (privateChat) {
      console.log(`🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
    } else {
      const topic = await room.topic()
      console.log(`🚪 Room: ${topic} 🤵 Contact: ${talker.name()} 💬 Text: ${rawText}`)
    }
    if (this.isNonsense(talker, messageType, rawText)) {
      return;
    }

    // Process audio message
    if (messageType == MessageType.Audio) {
      rawText = await this.processAudioMessage(message);
    }

    if (this.triggerGPTMessage(rawText, privateChat)) {
      if (messageType == MessageType.Audio) {
        rawText = rawText.slice(6);
      }
      const text = this.cleanMessage(rawText, privateChat);
      if (privateChat) {
        if (customerService) {
          return await this.onPrivateMessage(talker, text, customerService);
        }
        else {
          return await this.onPrivateMessage(talker, text);
        }
      } else {
        if (!this.disableGroupMessage) {
          return await this.onGroupMessage(talker, text, room);
        } else {
          return;
        }
      }
    } else {
      return;
    }
  }
}