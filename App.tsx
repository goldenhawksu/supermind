
import React, { useState, useEffect, useRef } from 'react';
import { ChatMessage, MessageSender, MessagePurpose, NotepadAction, NotepadUpdatePayload } from './types';
import { generateResponse } from './services/geminiService';
import ChatInput from './components/ChatInput';
import MessageBubble from './components/MessageBubble';
import Notepad from './components/Notepad';
import {
  MODELS,
  DEFAULT_MODEL_API_NAME,
  COGNITO_SYSTEM_PROMPT_HEADER,
  MUSE_SYSTEM_PROMPT_HEADER,
  DEFAULT_MANUAL_FIXED_TURNS,
  MIN_MANUAL_FIXED_TURNS,
  MAX_MANUAL_FIXED_TURNS,
  INITIAL_NOTEPAD_CONTENT,
  NOTEPAD_INSTRUCTION_PROMPT_PART,
  NOTEPAD_MODIFY_TAG_START,
  NOTEPAD_MODIFY_TAG_END,
  DISCUSSION_COMPLETE_TAG,
  AI_DRIVEN_DISCUSSION_INSTRUCTION_PROMPT_PART,
  DiscussionMode,
  MAX_AUTO_RETRIES,
  RETRY_DELAY_BASE_MS,
  THINKING_BUDGET_CONFIG_HIGH_QUALITY,
  THINKING_BUDGET_CONFIG_PRO_HIGH_QUALITY,
  GEMINI_PRO_MODEL_ID,
} from './constants';
import { BotMessageSquare, AlertTriangle, RefreshCcw as RefreshCwIcon, Cpu, MessagesSquare, Bot, SlidersHorizontal } from 'lucide-react';

interface ParsedAIResponse {
  spokenText: string;
  notepadUpdate: NotepadUpdatePayload;
  rawMalformattedNotepadJson?: string; // New field for the bad JSON string
  discussionShouldEnd?: boolean;
}

export interface FailedStepPayload {
  stepIdentifier: string;
  prompt: string;
  modelName: string;
  systemInstruction?: string;
  imageApiPart?: { inlineData: { mimeType: string; data: string } }; 
  sender: MessageSender;
  purpose: MessagePurpose;
  originalSystemErrorMsgId: string;
  thinkingConfig?: { thinkingBudget: number };
  userInputForFlow: string; 
  imageApiPartForFlow?: { inlineData: { mimeType: string; data: string } }; 
  discussionLogBeforeFailure: string[]; 
  currentTurnIndexForResume?: number; 
  previousAISignaledStopForResume?: boolean; 
}

const escapeRegExp = (string: string): string => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
};

const applyNotepadModifications = (currentContent: string, modifications: NotepadAction[]): { newContent: string; errors: string[] } => {
  let newContent = currentContent;
  const errors: string[] = [];

  modifications.forEach((mod, index) => {
    let lines = newContent.split('\n');
    const actionNum = index + 1;

    switch (mod.action) {
      case 'replace_all':
        newContent = mod.content;
        break;
      case 'append':
        newContent = newContent + mod.content;
        break;
      case 'prepend':
        newContent = mod.content + newContent;
        break;
      case 'replace_line': {
        const lineIdx = mod.line_number - 1; 
        if (lineIdx >= 0 && lineIdx < lines.length) {
          lines[lineIdx] = mod.content;
          newContent = lines.join('\n');
        } else {
          errors.push(`操作 ${actionNum} ("replace_line") 失败: 行号 ${mod.line_number} 超出范围 (总行数: ${lines.length})。`);
        }
        break;
      }
      case 'insert_after_line': {
        const lineIdx = mod.line_number - 1; 
        if (lineIdx >= -1 && lineIdx < lines.length) {
          lines.splice(lineIdx + 1, 0, mod.content);
          newContent = lines.join('\n');
        } else {
          errors.push(`操作 ${actionNum} ("insert_after_line") 失败: 行号 ${mod.line_number} 超出范围 (总行数: ${lines.length})。`);
        }
        break;
      }
      case 'delete_line': {
        const lineIdx = mod.line_number - 1; 
        if (lineIdx >= 0 && lineIdx < lines.length) {
          lines.splice(lineIdx, 1);
          newContent = lines.join('\n');
        } else {
          errors.push(`操作 ${actionNum} ("delete_line") 失败: 行号 ${mod.line_number} 超出范围 (总行数: ${lines.length})。`);
        }
        break;
      }
      case 'search_and_replace': {
        const safeSearchString = escapeRegExp(mod.search);
        if (mod.all) {
          const regex = new RegExp(safeSearchString, 'g');
          newContent = newContent.replace(regex, mod.replace);
        } else {
          newContent = newContent.replace(safeSearchString, mod.replace);
        }
        break;
      }
    }
  });

  return { newContent, errors };
};


const parseAIResponse = (responseText: string): ParsedAIResponse => {
  let currentText = responseText.trim();
  let spokenText = "";
  let notepadUpdate: NotepadUpdatePayload = null;
  let discussionShouldEnd = false;
  let rawMalformattedNotepadJson: string | undefined = undefined;

  let notepadActionText = "";
  let discussionActionText = "";

  const notepadStartIndex = currentText.lastIndexOf(NOTEPAD_MODIFY_TAG_START);
  const notepadEndIndex = currentText.lastIndexOf(NOTEPAD_MODIFY_TAG_END);
  
  if (notepadStartIndex !== -1 && notepadEndIndex > notepadStartIndex && currentText.endsWith(NOTEPAD_MODIFY_TAG_END)) {
    const jsonStr = currentText.substring(notepadStartIndex + NOTEPAD_MODIFY_TAG_START.length, notepadEndIndex).trim();
    spokenText = currentText.substring(0, notepadStartIndex).trim();
    
    try {
      const modifications: NotepadAction[] = JSON.parse(jsonStr);
      if (Array.isArray(modifications) && modifications.length > 0) {
        notepadUpdate = { modifications };
        notepadActionText = "修改了记事本";
      } else if (!Array.isArray(modifications)) {
         notepadUpdate = { error: "格式无效 (必须是JSON数组)" };
         rawMalformattedNotepadJson = jsonStr;
      } else { // Empty array, technically valid JSON but no-op for modifications
        notepadUpdate = null; // No effective update
        // notepadActionText remains empty or could be "attempted no changes"
      }
    } catch (e) {
      console.error("解析记事本JSON时出错:", e);
      notepadUpdate = { error: `格式无效 (JSON解析失败: ${(e as Error).message})` };
      rawMalformattedNotepadJson = jsonStr; // Store the problematic JSON string
      notepadActionText = "尝试修改记事本但失败了";
    }

  } else {
    spokenText = currentText;
  }
  
  if (spokenText.includes(DISCUSSION_COMPLETE_TAG)) {
    discussionShouldEnd = true;
    spokenText = spokenText.replace(new RegExp(escapeRegExp(DISCUSSION_COMPLETE_TAG), 'g'), "").trim();
    discussionActionText = "建议结束讨论";
  }

  if (!spokenText.trim() && (notepadActionText || discussionActionText)) {
    if (notepadActionText && discussionActionText) {
      spokenText = `(AI ${notepadActionText}并${discussionActionText})`;
    } else if (notepadActionText) {
      spokenText = `(AI ${notepadActionText})`;
    } else {
      spokenText = `(AI ${discussionActionText})`;
    }
  } else if (!spokenText.trim() && notepadUpdate === null && !discussionShouldEnd && rawMalformattedNotepadJson === undefined) {
    spokenText = "(AI 未提供额外文本回复)";
  }

  return { spokenText: spokenText.trim(), notepadUpdate, rawMalformattedNotepadJson, discussionShouldEnd };
};

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = (error) => reject(error);
  });
};

const generateUniqueId = () => Date.now().toString() + Math.random().toString(36).substr(2, 9);

const MIN_PANEL_PERCENT = 20; 
const MAX_PANEL_PERCENT = 80; 
const DEFAULT_CHAT_PANEL_PERCENT = 100 * (2/3); // Approx 66.67%

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isApiKeyMissing, setIsApiKeyMissing] = useState<boolean>(false);
  const [currentTotalProcessingTimeMs, setCurrentTotalProcessingTimeMs] = useState<number>(0);

  const [notepadContent, setNotepadContent] = useState<string>(INITIAL_NOTEPAD_CONTENT);
  const [lastNotepadUpdateBy, setLastNotepadUpdateBy] = useState<MessageSender | null>(null);
  const [discussionLog, setDiscussionLog] = useState<string[]>([]); 

  const [selectedModelApiName, setSelectedModelApiName] = useState<string>(DEFAULT_MODEL_API_NAME);
  const [discussionMode, setDiscussionMode] = useState<DiscussionMode>(DiscussionMode.AiDriven);
  const [manualFixedTurns, setManualFixedTurns] = useState<number>(DEFAULT_MANUAL_FIXED_TURNS);
  const [isThinkingBudgetActive, setIsThinkingBudgetActive] = useState<boolean>(true);

  const [failedStepInfo, setFailedStepInfo] = useState<FailedStepPayload | null>(null);
  const [isNotepadFullscreen, setIsNotepadFullscreen] = useState<boolean>(false);
  
  const [chatPanelWidthPercent, setChatPanelWidthPercent] = useState<number>(DEFAULT_CHAT_PANEL_PERCENT);
  const isResizingRef = useRef<boolean>(false);
  const initialMouseXRef = useRef<number>(0);
  const initialChatPanelWidthPercentRef = useRef<number>(0);
  const panelsContainerRef = useRef<HTMLDivElement>(null);


  const chatContainerRef = useRef<HTMLDivElement>(null);
  const currentQueryStartTimeRef = useRef<number | null>(null);
  const cancelRequestRef = useRef<boolean>(false);

  const currentModelDetails = MODELS.find(m => m.apiName === selectedModelApiName) || MODELS[0];

  const addMessage = (
    text: string,
    sender: MessageSender,
    purpose: MessagePurpose,
    durationMs?: number,
    image?: ChatMessage['image']
  ): string => {
    const messageId = generateUniqueId();
    setMessages(prev => [...prev, {
      id: messageId,
      text,
      sender,
      purpose,
      timestamp: new Date(),
      durationMs,
      image,
    }]);
    return messageId;
  };
  
  const processNotepadUpdate = (
    update: NotepadUpdatePayload,
    sender: MessageSender,
    rawMalformattedJson?: string
  ) => {
    if (!update && !rawMalformattedJson) return;

    if (update?.modifications) {
      const { newContent, errors } = applyNotepadModifications(notepadContent, update.modifications);
      setNotepadContent(newContent);
      setLastNotepadUpdateBy(sender);
      
      if (errors.length > 0) {
        const errorText = `[系统] ${sender} 的部分记事本修改操作未成功执行:\n- ${errors.join('\n- ')}`;
        addMessage(errorText, MessageSender.System, MessagePurpose.SystemNotification);
      }
    } else if (update?.error) {
      addMessage(
        `[系统] ${sender} 尝试修改记事本，但指令格式无效。记事本中显示了原始尝试。错误: ${update.error}`,
        MessageSender.System,
        MessagePurpose.SystemNotification
      );
      if (rawMalformattedJson !== undefined) {
        const header = `--- ${sender} 尝试进行无效的记事本修改 ---\n` +
                       `--- 错误: ${update.error} ---\n` +
                       `--- 原始尝试的修改内容如下: ---\n`;
        setNotepadContent(header + rawMalformattedJson);
        setLastNotepadUpdateBy(sender);
      }
    }
  };


  const getWelcomeMessageText = (
    modelName: string,
    currentDiscussionMode: DiscussionMode,
    currentManualFixedTurns: number
  ) => {
    let modeDescription = "";
     if (currentDiscussionMode === DiscussionMode.FixedTurns) {
      modeDescription = `固定轮次对话 (${currentManualFixedTurns}轮)`;
    } else {
      modeDescription = "AI驱动(不固定轮次)对话";
    }
    return `欢迎使用Dual AI Chat！当前模式: ${modeDescription}。在下方输入您的问题或上传图片。${MessageSender.Cognito} 和 ${MessageSender.Muse} 将进行讨论，然后 ${MessageSender.Cognito} 会将最终答案呈现在右侧的记事本中。当前模型: ${modelName}`;
  };

  const initializeChat = () => {
    setMessages([]);
    setNotepadContent(INITIAL_NOTEPAD_CONTENT);
    setLastNotepadUpdateBy(null);
    setDiscussionLog([]);
    setFailedStepInfo(null);
    cancelRequestRef.current = false;
    setIsNotepadFullscreen(false);


    if (!process.env.API_KEY) {
      setIsApiKeyMissing(true);
      addMessage(
        "严重警告：API_KEY 未配置。请确保设置 API_KEY 环境变量，以便应用程序正常运行。",
        MessageSender.System,
        MessagePurpose.SystemNotification
      );
    } else {
      setIsApiKeyMissing(false);
      addMessage(
        getWelcomeMessageText(currentModelDetails.name, discussionMode, manualFixedTurns),
        MessageSender.System,
        MessagePurpose.SystemNotification
      );
    }
  };

  useEffect(() => {
    initializeChat();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

   useEffect(() => {
     const welcomeMessage = messages.find(msg => msg.sender === MessageSender.System && msg.text.startsWith("欢迎使用Dual AI Chat！"));
     if (welcomeMessage && !isApiKeyMissing) {
        setMessages(msgs => msgs.map(msg =>
            msg.id === welcomeMessage.id
            ? {...msg, text: getWelcomeMessageText(currentModelDetails.name, discussionMode, manualFixedTurns) }
            : msg
        ));
     }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentModelDetails.name, isApiKeyMissing, discussionMode, manualFixedTurns]);

  useEffect(() => {
    let intervalId: number | undefined;
    if (isLoading && currentQueryStartTimeRef.current) {
      intervalId = window.setInterval(() => {
        if (currentQueryStartTimeRef.current && !cancelRequestRef.current) {
          setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
        }
      }, 100);
    } else {
      if (intervalId) clearInterval(intervalId);
      if (!isLoading && currentQueryStartTimeRef.current !== null) {
         setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
      }
    }
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [isLoading]);

  const handleClearChat = () => {
    if (isLoading) {
      cancelRequestRef.current = true;
    }
    setIsLoading(false);
    setCurrentTotalProcessingTimeMs(0);
    if (currentQueryStartTimeRef.current) {
        currentQueryStartTimeRef.current = null;
    }
    setMessages([]);
    setNotepadContent(INITIAL_NOTEPAD_CONTENT);
    setLastNotepadUpdateBy(null);
    setDiscussionLog([]);
    setFailedStepInfo(null);
    setIsNotepadFullscreen(false);


     if (!isApiKeyMissing) {
       addMessage(
        getWelcomeMessageText(currentModelDetails.name, discussionMode, manualFixedTurns),
        MessageSender.System,
        MessagePurpose.SystemNotification
      );
    } else {
         addMessage(
            "严重警告：API_KEY 未配置。请确保设置 API_KEY 环境变量，以便应用程序正常运行。",
            MessageSender.System,
            MessagePurpose.SystemNotification
      );
    }
  };

  const handleManualFixedTurnsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = parseInt(e.target.value, 10);
    if (isNaN(value)) {
      value = DEFAULT_MANUAL_FIXED_TURNS;
    }
    value = Math.max(MIN_MANUAL_FIXED_TURNS, Math.min(MAX_MANUAL_FIXED_TURNS, value));
    setManualFixedTurns(value);
  };

  const handleStopGenerating = () => {
    if (isLoading) {
      cancelRequestRef.current = true;
    }
  };

  const toggleNotepadFullscreen = () => {
    setIsNotepadFullscreen(prev => !prev);
  };

  useEffect(() => {
    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isNotepadFullscreen) {
        setIsNotepadFullscreen(false);
      }
    };
    document.addEventListener('keydown', handleEscKey);
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isNotepadFullscreen]);

  const handleMouseDownOnResizer = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    isResizingRef.current = true;
    initialMouseXRef.current = e.clientX;
    initialChatPanelWidthPercentRef.current = chatPanelWidthPercent;
    document.addEventListener('mousemove', handleMouseMoveOnDocument);
    document.addEventListener('mouseup', handleMouseUpOnDocument);
  };

  const handleMouseMoveOnDocument = (e: MouseEvent) => {
    if (!isResizingRef.current || !panelsContainerRef.current) return;
    const containerWidth = panelsContainerRef.current.offsetWidth;
    if (containerWidth === 0) return;

    const deltaX = e.clientX - initialMouseXRef.current;
    const deltaPercent = (deltaX / containerWidth) * 100;
    
    let newChatPanelWidthPercent = initialChatPanelWidthPercentRef.current + deltaPercent;

    newChatPanelWidthPercent = Math.max(MIN_PANEL_PERCENT, newChatPanelWidthPercent);
    newChatPanelWidthPercent = Math.min(MAX_PANEL_PERCENT, newChatPanelWidthPercent);
    
    setChatPanelWidthPercent(newChatPanelWidthPercent);
  };

  const handleMouseUpOnDocument = () => {
    isResizingRef.current = false;
    document.removeEventListener('mousemove', handleMouseMoveOnDocument);
    document.removeEventListener('mouseup', handleMouseUpOnDocument);
  };

  useEffect(() => {
    // Cleanup event listeners when component unmounts
    return () => {
      document.removeEventListener('mousemove', handleMouseMoveOnDocument);
      document.removeEventListener('mouseup', handleMouseUpOnDocument);
    };
  }, []);

  const handleResizerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const stepAmountPercent = 2; // Resize by 2% per key press

      let newWidthPercent = chatPanelWidthPercent;
      if (e.key === 'ArrowLeft') {
        newWidthPercent -= stepAmountPercent;
      } else if (e.key === 'ArrowRight') {
        newWidthPercent += stepAmountPercent;
      }
      
      newWidthPercent = Math.max(MIN_PANEL_PERCENT, newWidthPercent);
      newWidthPercent = Math.min(MAX_PANEL_PERCENT, newWidthPercent);
      setChatPanelWidthPercent(newWidthPercent);
    }
  };


  const continueDiscussionAfterSuccessfulRetry = async (
    retriedStepPayload: FailedStepPayload,
    retryResponse: ParsedAIResponse
  ) => {
    const {
      stepIdentifier: retriedStepId,
      userInputForFlow,
      imageApiPartForFlow,
    } = retriedStepPayload;

    let localDiscussionLog = [...retriedStepPayload.discussionLogBeforeFailure];
    localDiscussionLog.push(`${retriedStepPayload.sender}: ${retryResponse.spokenText}`);
    setDiscussionLog(localDiscussionLog); 

    let localLastTurnTextForLog = retryResponse.spokenText;
    let localPreviousAISignaledStop = (discussionMode === DiscussionMode.AiDriven && (retryResponse.discussionShouldEnd || false));
    if (discussionMode === DiscussionMode.AiDriven && retriedStepPayload.previousAISignaledStopForResume && retryResponse.discussionShouldEnd) {
        localPreviousAISignaledStop = true;
    }

    let activeThinkingConfig: { thinkingBudget: number } | undefined = undefined;
    if (currentModelDetails.supportsThinkingConfig && isThinkingBudgetActive) {
      activeThinkingConfig = currentModelDetails.apiName === GEMINI_PRO_MODEL_ID
        ? THINKING_BUDGET_CONFIG_PRO_HIGH_QUALITY.thinkingConfig
        : THINKING_BUDGET_CONFIG_HIGH_QUALITY.thinkingConfig;
    }

    const cognitoSysInstruction = currentModelDetails.supportsSystemInstruction ? COGNITO_SYSTEM_PROMPT_HEADER : undefined;
    const museSysInstruction = currentModelDetails.supportsSystemInstruction ? MUSE_SYSTEM_PROMPT_HEADER : undefined;

    const imageInstructionForAI = imageApiPartForFlow ? "用户还提供了一张图片。请在您的分析和回复中同时考虑此图片和文本查询。" : "";
    const discussionModeInstruction = discussionMode === DiscussionMode.AiDriven ? AI_DRIVEN_DISCUSSION_INSTRUCTION_PROMPT_PART : "";
    const commonPromptInstructions = () => NOTEPAD_INSTRUCTION_PROMPT_PART.replace('{notepadContent}', notepadContent) + discussionModeInstruction;

    let initialLoopTurn = 0;
    let skipMuseInFirstIteration = false;

    if (retriedStepId === 'cognito-initial-to-muse') {
        initialLoopTurn = 0;
        if (localPreviousAISignaledStop) addMessage(`${MessageSender.Cognito} 已建议结束讨论。等待 ${MessageSender.Muse} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
    } else if (retriedStepId.startsWith('muse-reply-to-cognito-turn-')) {
        initialLoopTurn = retriedStepPayload.currentTurnIndexForResume ?? 0;
        skipMuseInFirstIteration = true;
        if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop && retriedStepPayload.previousAISignaledStopForResume) {
            addMessage(`双方AI (${MessageSender.Cognito} 和 ${MessageSender.Muse}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
        } else if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop) {
             addMessage(`${MessageSender.Muse} 已建议结束讨论。等待 ${MessageSender.Cognito} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
        }
    } else if (retriedStepId.startsWith('cognito-reply-to-muse-turn-')) {
        initialLoopTurn = (retriedStepPayload.currentTurnIndexForResume ?? 0) + 1;
         if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop && retriedStepPayload.previousAISignaledStopForResume) {
             addMessage(`双方AI (${MessageSender.Muse} 和 ${MessageSender.Cognito}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
        } else if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop) {
             addMessage(`${MessageSender.Cognito} 已建议结束讨论。等待 ${MessageSender.Muse} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
        }
    } else if (retriedStepId === 'cognito-final-answer') {
        setIsLoading(false);
        if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
        currentQueryStartTimeRef.current = null;
        return;
    }


    try {
      let discussionLoopShouldRun = true;
      if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop && retriedStepPayload.previousAISignaledStopForResume) {
          discussionLoopShouldRun = false;
      }
      if (retriedStepId === 'cognito-final-answer') discussionLoopShouldRun = false;


      if (discussionLoopShouldRun) {
        for (let turn = initialLoopTurn; ; turn++) {
          if (cancelRequestRef.current) break;
          if (discussionMode === DiscussionMode.FixedTurns && turn >= manualFixedTurns) break;
          if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop && retriedStepPayload.previousAISignaledStopForResume && turn > initialLoopTurn) break;

          if (!(skipMuseInFirstIteration && turn === initialLoopTurn)) {
            const museStepIdentifier = `muse-reply-to-cognito-turn-${turn}`;
            addMessage(`${MessageSender.Muse} 正在回应 ${MessageSender.Cognito} (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
            let musePrompt = `${museSysInstruction ? museSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInputForFlow}". ${imageInstructionForAI} 当前讨论 (均为中文):\n${localDiscussionLog.join("\n")}\n${MessageSender.Cognito} (逻辑AI) 刚刚说 (中文): "${localLastTurnTextForLog}". 请回复 ${MessageSender.Cognito}。继续讨论。保持您的回复简洁并使用中文。\n${commonPromptInstructions()}`;
            if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop) musePrompt += `\n${MessageSender.Cognito} 已包含 ${DISCUSSION_COMPLETE_TAG} 建议结束讨论。如果您同意，请在您的回复中也包含 ${DISCUSSION_COMPLETE_TAG}。否则，请继续讨论。`;

            let museParsedResponse: ParsedAIResponse | null = null; let museStepSuccess = false;
            for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
              if (cancelRequestRef.current) break;
              try {
                const result = await generateResponse(musePrompt, selectedModelApiName, museSysInstruction, imageApiPartForFlow, activeThinkingConfig);
                if (cancelRequestRef.current) break;
                if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
                museParsedResponse = parseAIResponse(result.text); addMessage(museParsedResponse.spokenText, MessageSender.Muse, MessagePurpose.MuseToCognito, result.durationMs);
                museStepSuccess = true; break;
              } catch (e) {
                const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
                if (attempt < MAX_AUTO_RETRIES) { addMessage(`[续行-${MessageSender.Muse} @轮${turn+1}] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
                else { const errorMsgId = addMessage(`[续行-${MessageSender.Muse} @轮${turn+1}] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: museStepIdentifier, prompt: musePrompt, modelName: selectedModelApiName, systemInstruction: museSysInstruction, imageApiPart: imageApiPartForFlow, sender: MessageSender.Muse, purpose: MessagePurpose.MuseToCognito, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow, imageApiPartForFlow, discussionLogBeforeFailure: [...localDiscussionLog], currentTurnIndexForResume: turn, previousAISignaledStopForResume: localPreviousAISignaledStop }); return; }
              }
            }
            if (cancelRequestRef.current || !museStepSuccess || !museParsedResponse) return;
            processNotepadUpdate(museParsedResponse.notepadUpdate, MessageSender.Muse, museParsedResponse.rawMalformattedNotepadJson);
            const prevSignalBeforeMuse = localPreviousAISignaledStop;
            localLastTurnTextForLog = museParsedResponse.spokenText; localDiscussionLog.push(`${MessageSender.Muse}: ${localLastTurnTextForLog}`); setDiscussionLog([...localDiscussionLog]);
            localPreviousAISignaledStop = museParsedResponse.discussionShouldEnd || false;

            if (discussionMode === DiscussionMode.AiDriven) {
                if (localPreviousAISignaledStop && prevSignalBeforeMuse) {
                    addMessage(`双方AI (${MessageSender.Cognito} 和 ${MessageSender.Muse}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
                    break;
                } else if (localPreviousAISignaledStop) {
                    addMessage(`${MessageSender.Muse} 已建议结束讨论。等待 ${MessageSender.Cognito} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
                }
            }
          }
          skipMuseInFirstIteration = false;
          if (cancelRequestRef.current) break;
          if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop && retriedStepPayload.previousAISignaledStopForResume) break;
          if (discussionMode === DiscussionMode.FixedTurns && turn >= manualFixedTurns -1) break;

          const cognitoReplyStepIdentifier = `cognito-reply-to-muse-turn-${turn}`;
          addMessage(`${MessageSender.Cognito} 正在回应 ${MessageSender.Muse} (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
          let cognitoReplyPrompt = `${cognitoSysInstruction ? cognitoSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInputForFlow}". ${imageInstructionForAI} 当前讨论 (均为中文):\n${localDiscussionLog.join("\n")}\n${MessageSender.Muse} (创意AI) 刚刚说 (中文): "${localLastTurnTextForLog}". 请回复 ${MessageSender.Muse}。继续讨论。保持您的回复简洁并使用中文。\n${commonPromptInstructions()}`;
          if (discussionMode === DiscussionMode.AiDriven && localPreviousAISignaledStop) cognitoReplyPrompt += `\n${MessageSender.Muse} 已包含 ${DISCUSSION_COMPLETE_TAG} 建议结束讨论。如果您同意，请在您的回复中也包含 ${DISCUSSION_COMPLETE_TAG}。否则，请继续讨论。`;

          let cognitoReplyParsedResponse: ParsedAIResponse | null = null; let cognitoReplyStepSuccess = false;
          for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
            if (cancelRequestRef.current) break;
            try {
              const result = await generateResponse(cognitoReplyPrompt, selectedModelApiName, cognitoSysInstruction, imageApiPartForFlow, activeThinkingConfig);
              if (cancelRequestRef.current) break;
              if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
              cognitoReplyParsedResponse = parseAIResponse(result.text); addMessage(cognitoReplyParsedResponse.spokenText, MessageSender.Cognito, MessagePurpose.CognitoToMuse, result.durationMs);
              cognitoReplyStepSuccess = true; break;
            } catch (e) {
              const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
              if (attempt < MAX_AUTO_RETRIES) { addMessage(`[续行-${MessageSender.Cognito} @轮${turn+1}] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
              else { const errorMsgId = addMessage(`[续行-${MessageSender.Cognito} @轮${turn+1}] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: cognitoReplyStepIdentifier, prompt: cognitoReplyPrompt, modelName: selectedModelApiName, systemInstruction: cognitoSysInstruction, imageApiPart: imageApiPartForFlow, sender: MessageSender.Cognito, purpose: MessagePurpose.CognitoToMuse, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow, imageApiPartForFlow, discussionLogBeforeFailure: [...localDiscussionLog], currentTurnIndexForResume: turn, previousAISignaledStopForResume: localPreviousAISignaledStop }); return; }
            }
          }
          if (cancelRequestRef.current || !cognitoReplyStepSuccess || !cognitoReplyParsedResponse) return;
          processNotepadUpdate(cognitoReplyParsedResponse.notepadUpdate, MessageSender.Cognito, cognitoReplyParsedResponse.rawMalformattedNotepadJson);
          const prevSignalBeforeCognito = localPreviousAISignaledStop;
          localLastTurnTextForLog = cognitoReplyParsedResponse.spokenText; localDiscussionLog.push(`${MessageSender.Cognito}: ${localLastTurnTextForLog}`); setDiscussionLog([...localDiscussionLog]);
          localPreviousAISignaledStop = cognitoReplyParsedResponse.discussionShouldEnd || false;

          if (discussionMode === DiscussionMode.AiDriven) {
              if (localPreviousAISignaledStop && prevSignalBeforeCognito) {
                  addMessage(`双方AI (${MessageSender.Muse} 和 ${MessageSender.Cognito}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
                  break;
              } else if (localPreviousAISignaledStop) {
                  addMessage(`${MessageSender.Cognito} 已建议结束讨论。等待 ${MessageSender.Muse} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
              }
          }
          if (cancelRequestRef.current) break;
        }
      }


      if (cancelRequestRef.current) return;

      const finalAnswerStepIdentifier = 'cognito-final-answer';
      addMessage(`${MessageSender.Cognito} 正在综合讨论内容，准备最终答案 (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
      
      const finalAnswerPrompt = `${cognitoSysInstruction ? cognitoSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInputForFlow}". ${imageInstructionForAI} 您 (${MessageSender.Cognito}) 和 ${MessageSender.Muse} 进行了以下讨论 (均为中文):\n${localDiscussionLog.join("\n")}
      
**您的最终任务是为用户生成最终答案，并将其放入记事本中。**

**指令:**
1.  **生成最终答案:** 基于整个对话和当前记事本内容，综合所有要点，为用户创建一个全面、结构良好、易于理解的最终答案。答案必须是中文，并使用 Markdown 格式化以提高可读性。
2.  **更新记事本:** 使用 <notepad_modify> 标签和 "replace_all" 操作，将完整的最终答案放入记事本。这将是用户看到的主要输出。
3.  **口头回复:** 你的口头回复 (在 <notepad_modify> 标签之前的部分) 应该非常简短。只需告诉用户最终答案已在记事本中准备好。例如：“最终答案已为您准备好，请查看右侧的记事本。”

**严格遵守以上指令。最终答案必须在记事本中。**
\n${commonPromptInstructions()}`;

      let finalAnswerParsedResponse: ParsedAIResponse | null = null; let finalAnswerStepSuccess = false;
      for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
        if (cancelRequestRef.current) break;
        try {
          const result = await generateResponse(finalAnswerPrompt, selectedModelApiName, cognitoSysInstruction, imageApiPartForFlow, activeThinkingConfig);
          if (cancelRequestRef.current) break;
          if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
          finalAnswerParsedResponse = parseAIResponse(result.text); addMessage(finalAnswerParsedResponse.spokenText, MessageSender.Cognito, MessagePurpose.FinalResponse, result.durationMs);
          finalAnswerStepSuccess = true; break;
        } catch (e) {
          const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
          if (attempt < MAX_AUTO_RETRIES) { addMessage(`[续行-${MessageSender.Cognito} 最终答案] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
          else { const errorMsgId = addMessage(`[续行-${MessageSender.Cognito} 最终答案] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: finalAnswerStepIdentifier, prompt: finalAnswerPrompt, modelName: selectedModelApiName, systemInstruction: cognitoSysInstruction, imageApiPart: imageApiPartForFlow, sender: MessageSender.Cognito, purpose: MessagePurpose.FinalResponse, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow, imageApiPartForFlow, discussionLogBeforeFailure: [...localDiscussionLog] }); return; }
        }
      }
      if (cancelRequestRef.current || !finalAnswerStepSuccess || !finalAnswerParsedResponse) return;
      processNotepadUpdate(finalAnswerParsedResponse.notepadUpdate, MessageSender.Cognito, finalAnswerParsedResponse.rawMalformattedNotepadJson);

    } catch (error) {
      const catchedError = error as Error & {isApiKeyError?: boolean};
      if (cancelRequestRef.current && !catchedError.isApiKeyError) { /* User cancelled */ }
      else {
        console.error("继续讨论流程中发生错误:", catchedError);
        if (!messages.some(m => m.text.includes(catchedError.message))) {
            const displayError = (catchedError.isApiKeyError || catchedError.message.includes("API_KEY 未配置") || catchedError.message.includes("API密钥无效"))
            ? `错误：${catchedError.message} 请检查您的API密钥配置。聊天功能可能无法正常工作。`
            : `错误: ${catchedError.message}`;
            addMessage(displayError, MessageSender.System, MessagePurpose.SystemNotification, 0);
        }
        if (catchedError.isApiKeyError) setIsApiKeyMissing(true);
      }
    } finally {
      const wasCancelled = cancelRequestRef.current;
      setIsLoading(false);
      if (currentQueryStartTimeRef.current) {
        setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
      }
      currentQueryStartTimeRef.current = null;
      if (wasCancelled && !failedStepInfo) {
        addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification);
      }
    }
  };


  const handleSendMessage = async (userInput: string, imageFile?: File | null) => {
    if (isApiKeyMissing || isLoading) return;
    if (!userInput.trim() && !imageFile) return;

    cancelRequestRef.current = false;
    setIsLoading(true);
    setFailedStepInfo(null);
    currentQueryStartTimeRef.current = performance.now();
    setCurrentTotalProcessingTimeMs(0);
    setDiscussionLog([]);


    let userImageForDisplay: ChatMessage['image'] | undefined = undefined;
    if (imageFile) {
      const dataUrl = URL.createObjectURL(imageFile);
      userImageForDisplay = { dataUrl, name: imageFile.name, type: imageFile.type };
    }

    addMessage(userInput, MessageSender.User, MessagePurpose.UserInput, undefined, userImageForDisplay);

    let currentDiscussionLog: string[] = [];
    let lastTurnTextForLog = "";

    let imageApiPart: { inlineData: { mimeType: string; data: string } } | undefined = undefined;
    if (imageFile) {
      try {
        const base64Data = await fileToBase64(imageFile);
        imageApiPart = { inlineData: { mimeType: imageFile.type, data: base64Data } };
      } catch (error) {
        console.error("Error converting file to base64:", error);
        addMessage("图片处理失败，请重试。", MessageSender.System, MessagePurpose.SystemNotification);
        setIsLoading(false);
        currentQueryStartTimeRef.current = null;
        if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl);
        return;
      }
    }

    let activeThinkingConfig: { thinkingBudget: number } | undefined = undefined;
    if (currentModelDetails.supportsThinkingConfig && isThinkingBudgetActive) {
      activeThinkingConfig = currentModelDetails.apiName === GEMINI_PRO_MODEL_ID
        ? THINKING_BUDGET_CONFIG_PRO_HIGH_QUALITY.thinkingConfig
        : THINKING_BUDGET_CONFIG_HIGH_QUALITY.thinkingConfig;
    }
    
    const cognitoSysInstruction = currentModelDetails.supportsSystemInstruction ? COGNITO_SYSTEM_PROMPT_HEADER : undefined;
    const museSysInstruction = currentModelDetails.supportsSystemInstruction ? MUSE_SYSTEM_PROMPT_HEADER : undefined;

    const imageInstructionForAI = imageApiPart ? "用户还提供了一张图片。请在您的分析和回复中同时考虑此图片和文本查询。" : "";
    const discussionModeInstruction = discussionMode === DiscussionMode.AiDriven ? AI_DRIVEN_DISCUSSION_INSTRUCTION_PROMPT_PART : "";
    const commonPromptInstructions = () => NOTEPAD_INSTRUCTION_PROMPT_PART.replace('{notepadContent}', notepadContent) + discussionModeInstruction;

    try {
      const cognitoInitialStepIdentifier = 'cognito-initial-to-muse';
      addMessage(`${MessageSender.Cognito} 正在为 ${MessageSender.Muse} 准备第一个观点 (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
      const cognitoPrompt = `${cognitoSysInstruction ? cognitoSysInstruction + " " : ""}${`用户的查询 (中文) 是: "${userInput}". ${imageInstructionForAI} 请针对此查询提供您的初步想法或分析，以便 ${MessageSender.Muse} (创意型AI) 可以回应并与您开始讨论。用中文回答。`}\n${commonPromptInstructions()}`;

      let cognitoParsedResponse: ParsedAIResponse | null = null;
      let cognitoStepSuccess = false;

      for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
        if (cancelRequestRef.current) break;
        try {
          const result = await generateResponse(cognitoPrompt, selectedModelApiName, cognitoSysInstruction, imageApiPart, activeThinkingConfig);
          if (cancelRequestRef.current) break;
          if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
          cognitoParsedResponse = parseAIResponse(result.text);
          addMessage(cognitoParsedResponse.spokenText, MessageSender.Cognito, MessagePurpose.CognitoToMuse, result.durationMs);
          cognitoStepSuccess = true;
          break;
        } catch (e) {
          const error = e as Error & {isApiKeyError?: boolean};
          if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
          if (attempt < MAX_AUTO_RETRIES) {
            addMessage(`[${MessageSender.Cognito} 初步分析] 调用失败，正在重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1)));
          } else {
            const errorMsgId = addMessage(`[${MessageSender.Cognito} 初步分析] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 您可以手动重试此步骤。`, MessageSender.System, MessagePurpose.SystemNotification);
            setFailedStepInfo({ stepIdentifier: cognitoInitialStepIdentifier, prompt: cognitoPrompt, modelName: selectedModelApiName, systemInstruction: cognitoSysInstruction, imageApiPart, sender: MessageSender.Cognito, purpose: MessagePurpose.CognitoToMuse, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow: userInput, imageApiPartForFlow: imageApiPart, discussionLogBeforeFailure: [], previousAISignaledStopForResume: false });
            if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl);
            setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null;
            return;
          }
        }
      }
      if (cancelRequestRef.current || !cognitoStepSuccess || !cognitoParsedResponse) {
          if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl);
          setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null;
          if (cancelRequestRef.current && !failedStepInfo) addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification);
          return;
      }
      processNotepadUpdate(cognitoParsedResponse.notepadUpdate, MessageSender.Cognito, cognitoParsedResponse.rawMalformattedNotepadJson);
      lastTurnTextForLog = cognitoParsedResponse.spokenText;
      currentDiscussionLog.push(`${MessageSender.Cognito}: ${lastTurnTextForLog}`);
      setDiscussionLog([...currentDiscussionLog]);

      let previousAISignaledStop = discussionMode === DiscussionMode.AiDriven && (cognitoParsedResponse.discussionShouldEnd || false);
      if (previousAISignaledStop) addMessage(`${MessageSender.Cognito} 已建议结束讨论。等待 ${MessageSender.Muse} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);

      for (let turn = 0; ; turn++) {
        if (cancelRequestRef.current) break;
        if (discussionMode === DiscussionMode.FixedTurns && turn >= manualFixedTurns) break;
        if (discussionMode === DiscussionMode.AiDriven && previousAISignaledStop && cognitoParsedResponse.discussionShouldEnd && turn > 0) break;

        const museStepIdentifier = `muse-reply-to-cognito-turn-${turn}`;
        addMessage(`${MessageSender.Muse} 正在回应 ${MessageSender.Cognito} (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
        let musePrompt = `${museSysInstruction ? museSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInput}". ${imageInstructionForAI} 当前讨论 (均为中文):\n${currentDiscussionLog.join("\n")}\n${MessageSender.Cognito} (逻辑AI) 刚刚说 (中文): "${lastTurnTextForLog}". 请回复 ${MessageSender.Cognito}。继续讨论。保持您的回复简洁并使用中文。\n${commonPromptInstructions()}`;
        if (discussionMode === DiscussionMode.AiDriven && previousAISignaledStop) musePrompt += `\n${MessageSender.Cognito} 已包含 ${DISCUSSION_COMPLETE_TAG} 建议结束讨论。如果您同意，请在您的回复中也包含 ${DISCUSSION_COMPLETE_TAG}。否则，请继续讨论。`;

        let museParsedResponse: ParsedAIResponse | null = null; let museStepSuccess = false;
        for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
          if (cancelRequestRef.current) break;
          try {
            const result = await generateResponse(musePrompt, selectedModelApiName, museSysInstruction, imageApiPart, activeThinkingConfig);
            if (cancelRequestRef.current) break;
            if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
            museParsedResponse = parseAIResponse(result.text); addMessage(museParsedResponse.spokenText, MessageSender.Muse, MessagePurpose.MuseToCognito, result.durationMs);
            museStepSuccess = true; break;
          } catch (e) {
            const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
            if (attempt < MAX_AUTO_RETRIES) { addMessage(`[${MessageSender.Muse} 回应 @轮${turn+1}] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
            else { const errorMsgId = addMessage(`[${MessageSender.Muse} 回应 @轮${turn+1}] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: museStepIdentifier, prompt: musePrompt, modelName: selectedModelApiName, systemInstruction: museSysInstruction, imageApiPart, sender: MessageSender.Muse, purpose: MessagePurpose.MuseToCognito, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow: userInput, imageApiPartForFlow: imageApiPart, discussionLogBeforeFailure: [...currentDiscussionLog], currentTurnIndexForResume: turn, previousAISignaledStopForResume: previousAISignaledStop }); if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; return; }
          }
        }
        if (cancelRequestRef.current || !museStepSuccess || !museParsedResponse) { if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; if (cancelRequestRef.current && !failedStepInfo) addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification); return; }
        processNotepadUpdate(museParsedResponse.notepadUpdate, MessageSender.Muse, museParsedResponse.rawMalformattedNotepadJson);
        const signalFromCognito = previousAISignaledStop;
        lastTurnTextForLog = museParsedResponse.spokenText; currentDiscussionLog.push(`${MessageSender.Muse}: ${lastTurnTextForLog}`); setDiscussionLog([...currentDiscussionLog]);
        previousAISignaledStop = museParsedResponse.discussionShouldEnd || false;

        if (discussionMode === DiscussionMode.AiDriven) {
            if (previousAISignaledStop && signalFromCognito) {
                addMessage(`双方AI (${MessageSender.Cognito} 和 ${MessageSender.Muse}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
                break;
            } else if (previousAISignaledStop) {
                addMessage(`${MessageSender.Muse} 已建议结束讨论。等待 ${MessageSender.Cognito} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
            }
        }

        if (cancelRequestRef.current) break;
        if (discussionMode === DiscussionMode.FixedTurns && turn >= manualFixedTurns -1) break;

        const cognitoReplyStepIdentifier = `cognito-reply-to-muse-turn-${turn}`;
        addMessage(`${MessageSender.Cognito} 正在回应 ${MessageSender.Muse} (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);
        let cognitoReplyPrompt = `${cognitoSysInstruction ? cognitoSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInput}". ${imageInstructionForAI} 当前讨论 (均为中文):\n${currentDiscussionLog.join("\n")}\n${MessageSender.Muse} (创意AI) 刚刚说 (中文): "${lastTurnTextForLog}". 请回复 ${MessageSender.Muse}。继续讨论。保持您的回复简洁并使用中文。\n${commonPromptInstructions()}`;
        if (discussionMode === DiscussionMode.AiDriven && previousAISignaledStop) cognitoReplyPrompt += `\n${MessageSender.Muse} 已包含 ${DISCUSSION_COMPLETE_TAG} 建议结束讨论。如果您同意，请在您的回复中也包含 ${DISCUSSION_COMPLETE_TAG}。否则，请继续讨论。`;

        let cognitoReplyParsedResponse: ParsedAIResponse | null = null; let cognitoReplyStepSuccess = false;
        for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
           if (cancelRequestRef.current) break;
          try {
            const result = await generateResponse(cognitoReplyPrompt, selectedModelApiName, cognitoSysInstruction, imageApiPart, activeThinkingConfig);
            if (cancelRequestRef.current) break;
            if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
            cognitoReplyParsedResponse = parseAIResponse(result.text); addMessage(cognitoReplyParsedResponse.spokenText, MessageSender.Cognito, MessagePurpose.CognitoToMuse, result.durationMs);
            cognitoReplyStepSuccess = true; break;
          } catch (e) {
            const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
            if (attempt < MAX_AUTO_RETRIES) { addMessage(`[${MessageSender.Cognito} 回应 @轮${turn+1}] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
            else { const errorMsgId = addMessage(`[${MessageSender.Cognito} 回应 @轮${turn+1}] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: cognitoReplyStepIdentifier, prompt: cognitoReplyPrompt, modelName: selectedModelApiName, systemInstruction: cognitoSysInstruction, imageApiPart, sender: MessageSender.Cognito, purpose: MessagePurpose.CognitoToMuse, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow: userInput, imageApiPartForFlow: imageApiPart, discussionLogBeforeFailure: [...currentDiscussionLog], currentTurnIndexForResume: turn, previousAISignaledStopForResume: previousAISignaledStop }); if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; return; }
          }
        }
        if (cancelRequestRef.current || !cognitoReplyStepSuccess || !cognitoReplyParsedResponse) { if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; if (cancelRequestRef.current && !failedStepInfo) addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification); return; }
        processNotepadUpdate(cognitoReplyParsedResponse.notepadUpdate, MessageSender.Cognito, cognitoReplyParsedResponse.rawMalformattedNotepadJson);
        const signalFromMuse = previousAISignaledStop;
        lastTurnTextForLog = cognitoReplyParsedResponse.spokenText; currentDiscussionLog.push(`${MessageSender.Cognito}: ${lastTurnTextForLog}`); setDiscussionLog([...currentDiscussionLog]);
        previousAISignaledStop = cognitoReplyParsedResponse.discussionShouldEnd || false;

        if (discussionMode === DiscussionMode.AiDriven) {
            if (previousAISignaledStop && signalFromMuse) {
                addMessage(`双方AI (${MessageSender.Muse} 和 ${MessageSender.Cognito}) 已同意结束讨论。`, MessageSender.System, MessagePurpose.SystemNotification);
                break;
            } else if (previousAISignaledStop) {
                addMessage(`${MessageSender.Cognito} 已建议结束讨论。等待 ${MessageSender.Muse} 的回应。`, MessageSender.System, MessagePurpose.SystemNotification);
            }
        }
      }
      if (cancelRequestRef.current) {
          if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl);
          setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null;
          if (!failedStepInfo) addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification);
          return;
      }

      const finalAnswerStepIdentifier = 'cognito-final-answer';
      addMessage(`${MessageSender.Cognito} 正在综合讨论内容，准备最终答案 (使用 ${currentModelDetails.name})...`, MessageSender.System, MessagePurpose.SystemNotification);

      const finalAnswerPrompt = `${cognitoSysInstruction ? cognitoSysInstruction + " " : ""}用户的查询 (中文) 是: "${userInput}". ${imageInstructionForAI} 您 (${MessageSender.Cognito}) 和 ${MessageSender.Muse} 进行了以下讨论 (均为中文):\n${currentDiscussionLog.join("\n")}
      
**您的最终任务是为用户生成最终答案，并将其放入记事本中。**

**指令:**
1.  **生成最终答案:** 基于整个对话和当前记事本内容，综合所有要点，为用户创建一个全面、结构良好、易于理解的最终答案。答案必须是中文，并使用 Markdown 格式化以提高可读性。
2.  **更新记事本:** 使用 <notepad_modify> 标签和 "replace_all" 操作，将完整的最终答案放入记事本。这将是用户看到的主要输出。
3.  **口头回复:** 你的口头回复 (在 <notepad_modify> 标签之前的部分) 应该非常简短。只需告诉用户最终答案已在记事本中准备好。例如：“最终答案已为您准备好，请查看右侧的记事本。”

**严格遵守以上指令。最终答案必须在记事本中。**
\n${commonPromptInstructions()}`;

      let finalAnswerParsedResponse: ParsedAIResponse | null = null; let finalAnswerStepSuccess = false;
      for (let attempt = 0; attempt <= MAX_AUTO_RETRIES; attempt++) {
        if (cancelRequestRef.current) break;
        try {
          const result = await generateResponse(finalAnswerPrompt, selectedModelApiName, cognitoSysInstruction, imageApiPart, activeThinkingConfig);
          if (cancelRequestRef.current) break;
          if (result.error) throw result.error.includes("API key not valid") ? Object.assign(new Error(result.text), {isApiKeyError: true}) : new Error(result.text);
          finalAnswerParsedResponse = parseAIResponse(result.text); addMessage(finalAnswerParsedResponse.spokenText, MessageSender.Cognito, MessagePurpose.FinalResponse, result.durationMs);
          finalAnswerStepSuccess = true; break;
        } catch (e) {
          const error = e as Error & {isApiKeyError?: boolean}; if (error.isApiKeyError) { setIsApiKeyMissing(true); addMessage(`错误: ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); throw error; }
          if (attempt < MAX_AUTO_RETRIES) { addMessage(`[${MessageSender.Cognito} 最终答案] 调用失败，重试 (${attempt + 1}/${MAX_AUTO_RETRIES})... ${error.message}`, MessageSender.System, MessagePurpose.SystemNotification); await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_BASE_MS * (attempt + 1))); }
          else { const errorMsgId = addMessage(`[${MessageSender.Cognito} 最终答案] 在 ${MAX_AUTO_RETRIES + 1} 次尝试后失败: ${error.message} 可手动重试。`, MessageSender.System, MessagePurpose.SystemNotification); setFailedStepInfo({ stepIdentifier: finalAnswerStepIdentifier, prompt: finalAnswerPrompt, modelName: selectedModelApiName, systemInstruction: cognitoSysInstruction, imageApiPart, sender: MessageSender.Cognito, purpose: MessagePurpose.FinalResponse, originalSystemErrorMsgId: errorMsgId, thinkingConfig: activeThinkingConfig, userInputForFlow: userInput, imageApiPartForFlow: imageApiPart, discussionLogBeforeFailure: [...currentDiscussionLog] }); if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; return; }
        }
      }
      if (cancelRequestRef.current || !finalAnswerStepSuccess || !finalAnswerParsedResponse) { if (userImageForDisplay?.dataUrl.startsWith('blob:')) URL.revokeObjectURL(userImageForDisplay.dataUrl); setIsLoading(false); if (currentQueryStartTimeRef.current) setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current); currentQueryStartTimeRef.current = null; if (cancelRequestRef.current && !failedStepInfo) addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification); return; }
      processNotepadUpdate(finalAnswerParsedResponse.notepadUpdate, MessageSender.Cognito, finalAnswerParsedResponse.rawMalformattedNotepadJson);

    } catch (error) {
      const catchedError = error as Error & {isApiKeyError?: boolean};
      if (cancelRequestRef.current && !catchedError.isApiKeyError) { /* User cancelled */ }
      else {
        console.error("聊天流程中发生错误:", catchedError);
        if (!messages.some(m => m.text.includes(catchedError.message))) {
            const displayError = (catchedError.isApiKeyError || catchedError.message.includes("API_KEY 未配置") || catchedError.message.includes("API密钥无效"))
            ? `错误：${catchedError.message} 请检查您的API密钥配置。聊天功能可能无法正常工作。`
            : `错误: ${catchedError.message}`;
            addMessage(displayError, MessageSender.System, MessagePurpose.SystemNotification, 0);
        }
        if (catchedError.isApiKeyError) setIsApiKeyMissing(true);
      }
    } finally {
      const wasCancelled = cancelRequestRef.current;
      setIsLoading(false);

      if (userImageForDisplay?.dataUrl.startsWith('blob:')) {
        URL.revokeObjectURL(userImageForDisplay.dataUrl);
      }

      if (currentQueryStartTimeRef.current) {
        setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
      }
      currentQueryStartTimeRef.current = null;

      if (wasCancelled && !failedStepInfo) {
        addMessage("用户已停止AI响应。", MessageSender.System, MessagePurpose.SystemNotification);
      }
    }
  };

  const handleManualRetry = async (stepToRetry: FailedStepPayload) => {
    if (isLoading) return;

    setIsLoading(true);
    cancelRequestRef.current = false;
    currentQueryStartTimeRef.current = performance.now();
    setCurrentTotalProcessingTimeMs(0);

    setMessages(prev => prev.filter(m => m.id !== stepToRetry.originalSystemErrorMsgId));
    
    addMessage(
      `[${stepToRetry.sender} - ${stepToRetry.stepIdentifier}] 正在手动重试...`,
      MessageSender.System,
      MessagePurpose.SystemNotification
    );

    let parsedResponseFromRetry: ParsedAIResponse | null = null;

    try {
      // stepToRetry.systemInstruction will already be undefined if the model didn't support it
      // when the FailedStepPayload was created.
      const result = await generateResponse(
        stepToRetry.prompt,
        stepToRetry.modelName,
        stepToRetry.systemInstruction, 
        stepToRetry.imageApiPart,
        stepToRetry.thinkingConfig
      );

      if (cancelRequestRef.current) throw new Error("用户已停止手动重试");
      if (result.error) {
        if(result.error.includes("API key not valid")) { setIsApiKeyMissing(true); throw Object.assign(new Error(result.text), {isApiKeyError: true}); }
        throw new Error(result.text);
      }

      parsedResponseFromRetry = parseAIResponse(result.text);
      addMessage(parsedResponseFromRetry.spokenText, stepToRetry.sender, stepToRetry.purpose, result.durationMs);

      processNotepadUpdate(
        parsedResponseFromRetry.notepadUpdate, 
        stepToRetry.sender, 
        parsedResponseFromRetry.rawMalformattedNotepadJson
      );

      addMessage(`[${stepToRetry.sender} - ${stepToRetry.stepIdentifier}] 手动重试成功。后续流程将继续。`, MessageSender.System, MessagePurpose.SystemNotification);
      setFailedStepInfo(null);

      await continueDiscussionAfterSuccessfulRetry(stepToRetry, parsedResponseFromRetry);

    } catch (error) {
      const catchedError = error as Error & {isApiKeyError?: boolean};

      if (cancelRequestRef.current && !catchedError.isApiKeyError) { /* User cancelled */ }
      else {
        console.error("手动重试失败:", catchedError);
        const errorMsg = catchedError.message || "未知错误";
        // Ensure systemInstruction for the new failedStepInfo is also conditional
        const systemInstructionForNewFailure = 
            stepToRetry.sender === MessageSender.Cognito ? (currentModelDetails.supportsSystemInstruction ? COGNITO_SYSTEM_PROMPT_HEADER : undefined)
          : stepToRetry.sender === MessageSender.Muse ? (currentModelDetails.supportsSystemInstruction ? MUSE_SYSTEM_PROMPT_HEADER : undefined)
          : undefined;

        const newErrorMsgId = addMessage(
            `[${stepToRetry.sender} - ${stepToRetry.stepIdentifier}] 手动重试失败: ${errorMsg}. 您可以再次尝试。`,
            MessageSender.System,
            MessagePurpose.SystemNotification
        );
        if (catchedError.isApiKeyError) setIsApiKeyMissing(true);
        setFailedStepInfo({ ...stepToRetry, originalSystemErrorMsgId: newErrorMsgId, systemInstruction: systemInstructionForNewFailure });
      }
    } finally {
      if (failedStepInfo || cancelRequestRef.current) {
         setIsLoading(false);
         if (currentQueryStartTimeRef.current) {
            setCurrentTotalProcessingTimeMs(performance.now() - currentQueryStartTimeRef.current);
         }
         currentQueryStartTimeRef.current = null;
         if (cancelRequestRef.current && !failedStepInfo) {
             addMessage("用户已停止手动重试。", MessageSender.System, MessagePurpose.SystemNotification);
         }
      }
    }
  };

  const Separator = () => <div className="h-6 w-px bg-gray-300 mx-1 md:mx-1.5" aria-hidden="true"></div>;

  return (
    <div className={`flex flex-col h-screen bg-white shadow-2xl overflow-hidden border-x border-gray-300 ${isNotepadFullscreen ? 'fixed inset-0 z-40' : 'relative'}`}>
      <header className={`p-4 bg-gray-50 border-b border-gray-300 flex items-center justify-between shrink-0 space-x-2 md:space-x-4 flex-wrap ${isNotepadFullscreen ? 'relative z-0' : 'relative z-10'}`}>
        <div className="flex items-center shrink-0">
          <BotMessageSquare size={28} className="mr-2 md:mr-3 text-sky-600" />
          <h1 className="text-xl md:text-2xl font-semibold text-sky-600">Dual AI Chat</h1>
        </div>

        <div className="flex items-center space-x-2 md:space-x-3 flex-wrap justify-end gap-y-2">
          <div className="flex items-center">
            <label htmlFor="modelSelector" className="text-sm text-gray-700 mr-1.5 flex items-center shrink-0">
              {/* Content (icon and text) removed */}
            </label>
            <select id="modelSelector" value={selectedModelApiName} onChange={(e) => setSelectedModelApiName(e.target.value)}
              className="bg-white border border-gray-400 text-gray-800 text-sm rounded-md p-1.5 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-none disabled:opacity-70 disabled:cursor-not-allowed w-44"
              aria-label="选择AI模型" disabled={isLoading}>
              {MODELS.map((model) => (<option key={model.id} value={model.apiName}>{model.name}</option>))}
            </select>
          </div>
          <Separator />
          <div className="flex items-center space-x-1.5">
            <label htmlFor="discussionModeToggle" className={`flex items-center text-sm text-gray-700 ${isLoading ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer hover:text-sky-600'}`}
              title={discussionMode === DiscussionMode.FixedTurns ? "切换到不固定轮次模式" : "切换到固定轮次模式"}>
              {discussionMode === DiscussionMode.FixedTurns ? <MessagesSquare size={18} className="mr-1 text-sky-600" /> : <Bot size={18} className="mr-1 text-sky-600" />}
              <span className="mr-1 select-none shrink-0">轮数:</span>
              <div className="relative"><input type="checkbox" id="discussionModeToggle" className="sr-only peer" checked={discussionMode === DiscussionMode.AiDriven}
                  onChange={() => !isLoading && setDiscussionMode(prev => prev === DiscussionMode.FixedTurns ? DiscussionMode.AiDriven : DiscussionMode.FixedTurns)}
                  aria-label="切换对话轮数模式" disabled={isLoading} />
                <div className={`block w-10 h-6 rounded-full transition-colors ${discussionMode === DiscussionMode.AiDriven ? 'bg-sky-500' : 'bg-gray-400'} ${isLoading ? 'opacity-70' : ''}`}></div>
                <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${discussionMode === DiscussionMode.AiDriven ? 'translate-x-4' : ''}`}></div>
              </div><span className="ml-1.5 select-none shrink-0 min-w-[4rem] text-left">{discussionMode === DiscussionMode.FixedTurns ? '固定' : '不固定'}</span>
            </label>
            {discussionMode === DiscussionMode.FixedTurns && (
              <div className="flex items-center text-sm text-gray-700">
                <input type="number" id="manualFixedTurnsInput" value={manualFixedTurns} onChange={handleManualFixedTurnsChange}
                  min={MIN_MANUAL_FIXED_TURNS} max={MAX_MANUAL_FIXED_TURNS} disabled={isLoading}
                  className="w-14 bg-white border border-gray-400 text-gray-800 text-sm rounded-md p-1 text-center focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-none disabled:opacity-70 disabled:cursor-not-allowed"/>
                <span className="ml-1 select-none">轮</span>
              </div>)}
          </div>
           <Separator />
            <label htmlFor="thinkingBudgetToggle"
            className={`flex items-center text-sm text-gray-700 transition-opacity ${isLoading || !currentModelDetails.supportsThinkingConfig ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer hover:text-sky-600'}`}
            title={currentModelDetails.supportsThinkingConfig ? "切换支持模型的思考预算。优质模式使用特定预算以获得更高质量的回复。标准模式依赖 API 默认行为。" : "当前模型不支持思考预算配置"}>
            <SlidersHorizontal size={18} className={`mr-1 ${currentModelDetails.supportsThinkingConfig && isThinkingBudgetActive ? 'text-sky-600' : 'text-gray-400'}`} />
            <span className="mr-1.5 select-none shrink-0">预算:</span>
            <div className="relative">
              <input type="checkbox" id="thinkingBudgetToggle" className="sr-only peer"
                     checked={isThinkingBudgetActive}
                     onChange={() => {!isLoading && currentModelDetails.supportsThinkingConfig && setIsThinkingBudgetActive(prev => !prev)}}
                     disabled={isLoading || !currentModelDetails.supportsThinkingConfig}
                     aria-label="切换AI思考预算模式" />
              <div className={`block w-10 h-6 rounded-full transition-colors ${currentModelDetails.supportsThinkingConfig ? (isThinkingBudgetActive ? 'bg-sky-500' : 'bg-gray-400') : 'bg-gray-300'} ${isLoading ? 'opacity-70' : ''}`}></div>
              <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${currentModelDetails.supportsThinkingConfig && isThinkingBudgetActive ? 'translate-x-4' : ''}`}></div>
            </div>
             <span className="ml-1.5 select-none shrink-0 min-w-[3rem] text-left">
                {currentModelDetails.supportsThinkingConfig ? (isThinkingBudgetActive ? '优质' : '标准') : 'N/A'}
             </span>
          </label>
           <Separator />
          <button onClick={handleClearChat}
            className="p-2 text-gray-500 hover:text-sky-600 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-gray-50 rounded-md shrink-0 disabled:opacity-70 disabled:cursor-not-allowed"
            aria-label="清空会话" title="清空会话" disabled={isLoading && !cancelRequestRef.current && !failedStepInfo}
            ><RefreshCwIcon size={22} />
          </button>
        </div>
      </header>

      <div ref={panelsContainerRef} className={`flex flex-row flex-grow overflow-hidden ${isNotepadFullscreen ? 'relative' : ''}`}>
        {!isNotepadFullscreen && (
          <div
            id="chat-panel-wrapper"
            className="flex flex-col h-full overflow-hidden"
            style={{ width: `${chatPanelWidthPercent}%` }}
          >
            <div className="flex flex-col flex-grow h-full"> {/* Inner wrapper for message list and input */}
              <div ref={chatContainerRef} className="flex-grow p-4 space-y-4 overflow-y-auto bg-gray-200 scroll-smooth">
                {messages.map((msg) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    failedStepPayloadForThisMessage={failedStepInfo && msg.id === failedStepInfo.originalSystemErrorMsgId ? failedStepInfo : null}
                    onManualRetry={handleManualRetry}
                  />
                ))}
              </div>
              <ChatInput
                onSendMessage={handleSendMessage}
                isLoading={isLoading}
                isApiKeyMissing={isApiKeyMissing}
                onStopGenerating={handleStopGenerating}
              />
            </div>
          </div>
        )}

        {!isNotepadFullscreen && (
          <div
            id="panel-resizer"
            className="w-1.5 h-full bg-gray-300 hover:bg-sky-500 cursor-col-resize select-none shrink-0 transition-colors duration-150 ease-in-out focus:outline-none focus:ring-1 focus:ring-sky-600"
            onMouseDown={handleMouseDownOnResizer}
            onKeyDown={handleResizerKeyDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动以调整聊天和记事本面板大小"
            aria-controls="chat-panel-wrapper notepad-panel-wrapper"
            aria-valuenow={chatPanelWidthPercent}
            aria-valuemin={MIN_PANEL_PERCENT}
            aria-valuemax={MAX_PANEL_PERCENT}
            tabIndex={0}
            title="拖动或使用方向键调整大小"
          />
        )}
        
        <div
          id="notepad-panel-wrapper"
          className={`h-full bg-gray-50 flex flex-col ${
            isNotepadFullscreen 
            ? 'fixed inset-0 z-50 w-screen' 
            : 'overflow-hidden'
          }`}
          style={!isNotepadFullscreen ? { width: `${100 - chatPanelWidthPercent}%` } : {}}
        >
          <Notepad 
            content={notepadContent} 
            lastUpdatedBy={lastNotepadUpdateBy} 
            isLoading={isLoading}
            isNotepadFullscreen={isNotepadFullscreen}
            onToggleFullscreen={toggleNotepadFullscreen}
          />
        </div>
      </div>

      { (isLoading || (currentTotalProcessingTimeMs > 0 && currentQueryStartTimeRef.current === null)) && !isNotepadFullscreen && (
         <div className="fixed bottom-4 right-4 md:bottom-6 md:right-6 bg-white bg-opacity-90 text-gray-700 p-2 rounded-md shadow-lg text-xs z-50 border border-gray-300">
            {isLoading ? '处理中: ' : '总耗时: '} {(currentTotalProcessingTimeMs / 1000).toFixed(2)}s
        </div>
      )}
       {isApiKeyMissing &&
        !messages.some(msg => msg.text.includes("API_KEY 未配置") || msg.text.includes("API密钥无效")) &&
        !messages.some(msg => msg.text.includes("严重警告：API_KEY 未配置")) &&
        !isNotepadFullscreen &&
        (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 p-3 bg-red-100 text-red-700 border border-red-300 rounded-lg shadow-lg flex items-center text-sm z-50">
            <AlertTriangle size={20} className="mr-2" /> API密钥未配置或无效。请检查控制台获取更多信息。
        </div>
      )}
    </div>
  );
};

export default App;