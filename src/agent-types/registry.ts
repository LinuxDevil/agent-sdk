import { AgentType, AgentTypeDescriptor } from '../types';

/**
 * Agent types registry
 * Contains all available agent type descriptors
 */
export const agentTypesRegistry: AgentTypeDescriptor[] = [
  {
    type: AgentType.SmartAssistant,
    description: {
      ar: "المساعدون الأذكياء هم **وكلاء متعددو الأغراض**. يمكنهم استخدام الأدوات، على سبيل المثال، للتحقق من التقويم الخاص بك أو حجز أحداث جديدة. يمكن استخدامها أيضًا للاستطلاعات (مع مهام أخرى) ولكن يجب تخصيصها للقيام بذلك على مستوى الموجه.",
      en: "Smart assistants are **general-purpose agents**. They can use tools, for example, checking your calendar or booking new events. They can also be used for surveys (mixed with other tasks) but need to be fine-tuned for doing so at the prompt level."    
    },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: {
      'ar': 'مساعد ذكي [محادثة]',
      'en': 'Smart assistant [Chat]'
    }
  },
  {
    type: AgentType.SurveyAgent,
    description: {
      ar: "يتم استخدام وكلاء الاستطلاع لجمع المعلومات أو الآراء من المستخدمين. بناءً على الإجابات السابقة، يمكنهم **ضبط الأسئلة التالية ديناميكيًا**. يحفظ هؤلاء الوكلاء الإجابات لمزيد من المعالجة بالتنسيق المطلوب. يمكنهم استبدال أدوات مثل **النماذج، الاستطلاعات، نماذج التسجيل** وما إلى ذلك.",
      en: "Survey agents are used to collect information or opinions from users. Based on previous answers, they can **dynamically adjust** the next questions. These agents save the answers for further processing in the desired format. They can replace tools like **Forms, Polls, Intake forms** etc."    
    },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: {
      'ar': 'وكيل استطلاع [محادثة]',
      'en': 'Survey agent [Chat]'
    }
  },
  {
    type: AgentType.CommerceAgent,
    description: {
      ar: "يُستخدم الوكلاء التجاريون **لبيع المنتجات أو الخدمات**. يمكن استخدامها في **التجارة الإلكترونية**، **حجز الخدمات**، سيناريوهات **b2b/cpq**. يعملون على **كتالوج المنتجات** ويمكن استخدامها **للبيع الإضافي** أو **البيع المتقاطع** للمنتجات.",
      en: "Commerce agents are used to **sell products or services**. They can be used in **e-commerce**, **service booking**, **b2b/cpq** scenarios. They operate on the **product catalog** and can be used to **upsell** or **cross-sell** products."            
    },
    supportsUserFacingUI: true,
    requiredTabs: ['prompt', 'expectedResult'],
    displayName: {
      'ar': 'مساعد مبيعات [محادثة]',
      'en': 'Sales assistant [Chat]'
    }
  },
  {
    type: AgentType.Flow,
    description: {
      ar: "تتيح لك الوكلاء المعتمدون على التدفق إنشاء **سيناريوهات معقدة**. يمكن استخدامها **لأتمتة العمليات** وتطوير التطبيقات التي يتم استدعاؤها بواسطة API أو وكلاء آخرين، باستخدام **اللغة الطبيعية**. يمكن استخدامها **لإنشاء أشجار القرار** أو **التكاملات**.",
      en: "Flow-based agents let you create **complex scenarios**. They can be used to **automate processes** and develop apps that are called by API or other agents, using **natural language**. They can be used to **create decision trees** or **integrations**."    
    },
    supportsUserFacingUI: true,
    requiredTabs: [],
    displayName: {
      'ar': 'تطبيق / سير عمل [API]',
      'en': 'App / Workflow [API]'
    }
  }
];

/**
 * Get agent type descriptor by type
 */
export function getAgentTypeDescriptor(type: AgentType): AgentTypeDescriptor | undefined {
  return agentTypesRegistry.find(descriptor => descriptor.type === type);
}

/**
 * Get all agent type descriptors
 */
export function getAllAgentTypeDescriptors(): AgentTypeDescriptor[] {
  return [...agentTypesRegistry];
}

/**
 * Check if agent type is valid
 */
export function isValidAgentType(type: string): type is AgentType {
  return agentTypesRegistry.some(descriptor => descriptor.type === type);
}
