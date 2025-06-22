export const GEMINI_2_5_FLASH_MODEL_ID = 'gemini-2.5-flash';
export const GEMINI_PRO_MODEL_ID = 'gemini-2.5-pro';
export const GEMINI_FLASH_LITE_PREVIEW_MODEL_ID = 'gemini-2.5-flash-lite-preview-06-17';
export const GEMMA_3_27B_IT_MODEL_ID = 'gemma-3-27b-it';

export interface AiModel {
  id: string;
  name: string;
  apiName: string;
  supportsThinkingConfig?: boolean;
  supportsSystemInstruction?: boolean;
}

export const MODELS: AiModel[] = [
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    apiName: GEMINI_2_5_FLASH_MODEL_ID,
    supportsThinkingConfig: true,
    supportsSystemInstruction: true,
  },
  {
    id: 'pro-2.5',
    name: 'Gemini 2.5 Pro',
    apiName: GEMINI_PRO_MODEL_ID,
    supportsThinkingConfig: true, 
    supportsSystemInstruction: true,
  },
  {
    id: 'flash-lite-preview-06-17',
    name: 'Gemini 2.5 Flash Lite',
    apiName: GEMINI_FLASH_LITE_PREVIEW_MODEL_ID,
    supportsThinkingConfig: true,
    supportsSystemInstruction: true,
  },
  {
    id: 'gemma-3-27b-it',
    name: 'Gemma-3-27B',
    apiName: GEMMA_3_27B_IT_MODEL_ID,
    supportsThinkingConfig: false,
    supportsSystemInstruction: false,
  },
];

export const DEFAULT_MODEL_API_NAME = MODELS[0].apiName;

// Configuration for a high-quality thinking budget for Flash models
export const THINKING_BUDGET_CONFIG_HIGH_QUALITY = { thinkingConfig: { thinkingBudget: 24576 } };

// Configuration for a high-quality thinking budget for Pro model
export const THINKING_BUDGET_CONFIG_PRO_HIGH_QUALITY = { thinkingConfig: { thinkingBudget: 32768 } };

export const COGNITO_SYSTEM_PROMPT_HEADER = "You are Cognito, a highly logical and analytical AI. Your primary role is to ensure accuracy, coherence, and **direct relevance to the user's query**. Your AI partner, Muse, is designed to be highly skeptical and will critically challenge your points with a demanding tone. Work *with* Muse to produce the best possible answer for the user. **Always keep the user's original request as the central focus of your discussion and final output.** Maintain your logical rigor and provide clear, well-supported arguments to address Muse's skepticism. Your dialogue will be a rigorous, constructive debate, even if challenging. Strive for an optimal, high-quality, and comprehensive final response **that directly and thoroughly answers the user's specific question(s)**. Ensure all necessary facets relevant to the user's query are explored before signaling to end the discussion.";
export const MUSE_SYSTEM_PROMPT_HEADER = "You are Muse, a highly creative but deeply skeptical AI. Your primary role is to rigorously challenge assumptions and ensure every angle is thoroughly scrutinized **to ultimately satisfy the user's request**. Your AI partner, Cognito, is logical and analytical. Your task is to provoke Cognito into deeper thinking by adopting a challenging, even slightly taunting, yet professional tone. Question Cognito's statements intensely: 'Are you *sure* about that?', 'That sounds too simple, what are you missing in relation to the user's problem?', 'Is that *all* you've got, Cognito, to address what the user asked for?'. Don't just accept Cognito's points; dissect them, demand an unassailable justification, and explore unconventional alternatives, even if they seem outlandish at first, **as long as they contribute to a better answer for the user**. Your aim is not to simply praise or agree, but to force a more robust and comprehensive answer **that precisely meets the user's needs** through relentless, critical, and imaginative inquiry. Ensure your 'challenges' are **always focused on the problem at hand as presented by the user**. Your dialogue should be a serious, rigorous, and intellectually demanding debate leading to an optimal, high-quality final response **for the user**. Ensure all necessary facets **relevant to the user's query** are explored before signaling to end the discussion.";

export const DEFAULT_MANUAL_FIXED_TURNS = 2;
export const MIN_MANUAL_FIXED_TURNS = 1;
export const MAX_MANUAL_FIXED_TURNS = 5;

export const INITIAL_NOTEPAD_CONTENT = ``;

export const NOTEPAD_INSTRUCTION_PROMPT_PART = `
You also have access to a shared notepad.
Current Notepad Content:
---
{notepadContent}
---
Instructions for Modifying the Notepad:
1. To modify the notepad, include a section at the very end of your response, formatted exactly as:
   <notepad_modify>
   [AN ARRAY OF JSON OBJECTS REPRESENTING YOUR ACTIONS]
   </notepad_modify>
2. The content inside the tag MUST be a valid JSON array. Each object in the array represents one action to be performed in order.
3. If you do not want to change the notepad, do NOT include the <notepad_modify> section at all.
4. Your primary spoken response to the ongoing discussion should come BEFORE any <notepad_modify> section.

Valid Actions (JSON objects):
- Replace all content: { "action": "replace_all", "content": "New full content." }
- Append text: { "action": "append", "content": "\\n- A new item to add." } (Use \\n for newlines)
- Prepend text: { "action": "prepend", "content": "## New Title\\n" }
- Insert after a specific line: { "action": "insert_after_line", "line_number": 5, "content": "This text is inserted after line 5." } (Line numbers are 1-based)
- Replace a specific line: { "action": "replace_line", "line_number": 8, "content": "This is the new content for line 8." }
- Delete a specific line: { "action": "delete_line", "line_number": 3 }
- Search and replace text: { "action": "search_and_replace", "search": "old text", "replace": "new text", "all": true } ('all' is optional, defaults to first match. Note: Special regex characters in 'search' will be treated as literal characters.)

Example of a valid modification block:
<notepad_modify>
[
  { "action": "delete_line", "line_number": 1 },
  { "action": "append", "content": "\\n- Final conclusion." }
]
</notepad_modify>
`;

export const NOTEPAD_MODIFY_TAG_START = "<notepad_modify>";
export const NOTEPAD_MODIFY_TAG_END = "</notepad_modify>";

export const DISCUSSION_COMPLETE_TAG = "";

export const AI_DRIVEN_DISCUSSION_INSTRUCTION_PROMPT_PART = `
Instruction for ending discussion: If you believe the current topic has been sufficiently explored between you and your AI partner for Cognito to synthesize a final answer for the user, include the exact tag ${DISCUSSION_COMPLETE_TAG} at the very end of your current message (after any notepad update). Do not use this tag if you wish to continue the discussion or require more input/response from your partner.
`;

export enum DiscussionMode {
  FixedTurns = 'fixed',
  AiDriven = 'ai-driven',
}

export const MAX_AUTO_RETRIES = 2;
export const RETRY_DELAY_BASE_MS = 1000;