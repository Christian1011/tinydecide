// A simulated support-ticket classifier, used by `tinydecide try` in place of a real API.
//
// It labels customer messages the way an LLM classifier does at temperature 0: the same text always
// gets the same label, clear messages get the obvious label (with a little noise), and vague or
// mixed messages get a label no word-level model could predict. No network, no keys.

import { hashString, rng } from '../src/hash.js';

export const LABELS = ['refund', 'billing', 'login', 'order_status', 'change_address', 'cancel', 'upgrade', 'bug', 'feature_request', 'human'];

const SLOTS = {
  item: ['my headphones', 'the blender', 'the jacket', 'the charger', 'the desk lamp', 'my shoes', 'the coffee maker', 'the backpack', 'the keyboard', 'my phone case', 'the monitor', 'the rug', 'the tent', 'the kettle', 'my sunglasses'],
  plan: ['pro', 'the team plan', 'premium', 'the annual plan', 'business', 'the family plan'],
  card: ['visa', 'credit card', 'bank', 'amex', 'paypal', 'debit card'],
  device: ['iphone', 'android', 'my laptop', 'chrome', 'safari', 'the ipad app', 'windows'],
  city: ['denver', 'austin', 'seattle', 'boston', 'chicago', 'portland', 'atlanta', 'miami', 'phoenix', 'toronto'],
  action: ['upload a photo', 'check out', 'open settings', 'export a report', 'log out', 'search', 'save my profile', 'add a card'],
  feature: ['search', 'checkout', 'the dashboard', 'notifications', 'sync', 'the mobile app', 'file upload', 'the calendar'],
  wish: ['dark mode', 'bulk export', 'a public api', 'offline mode', 'calendar sync', 'sms login', 'more themes', 'csv import'],
  integration: ['slack', 'zapier', 'shopify', 'google sheets', 'salesforce', 'notion', 'hubspot'],
  code: ['500', '403', 'E1029', '404', 'TIMEOUT', 'E-77', '502'],
};

const TEMPLATES = {
  refund: ['i want a refund for {item}', 'can i get my money back for {item}', 'please refund order {order}', '{item} arrived broken, i want a refund', 'how do i return {item}', 'requesting a refund, {item} is not what i ordered', 'refund please, {item} stopped working after a week', 'i returned {item} two weeks ago and still no refund'],
  billing: ['i was charged twice for {plan}', 'there are two charges of ${amount} on my {card}', 'why was i billed ${amount} this month', 'unexpected charge on my {card} statement', 'my invoice says ${amount} but it should be less', 'duplicate charge for order {order}', 'what is this ${amount} charge'],
  login: ["i can't log in", 'my password reset email never arrives', 'locked out of my account after too many attempts', "the 2fa code isn't working", 'it says invalid password but i know it is right', "can't sign in on {device}", 'login page keeps spinning on {device}', 'forgot my password and the reset link expired'],
  order_status: ['where is my order {order}', "my package hasn't arrived yet", 'tracking says delivered but i got nothing', 'when will {item} ship', 'order {order} is stuck in processing', 'any update on {item}? it has been ten days', 'has order {order} shipped'],
  change_address: ['i need to change my shipping address', 'please send order {order} to {city} instead', 'i moved to {city}, update my address', 'wrong address on order {order}', 'can i change where {item} gets delivered'],
  cancel: ['cancel my subscription', 'how do i cancel {plan}', "please don't renew my plan", 'i want to close my account', 'cancel {plan} at the end of the month', 'end my membership please', 'how do i stop my subscription'],
  upgrade: ['how do i upgrade to {plan}', 'what does {plan} cost', 'i need more seats for my team', 'switch me to {plan}', 'is there a discount for {plan}', 'can i try {plan} before paying', 'upgrade my account to {plan}'],
  bug: ['the app crashes when i {action}', '{feature} is broken on {device}', 'getting error {code} when i {action}', "the page won't load on {device}", '{feature} has been down since this morning', 'error {code} every time i {action}', '{feature} shows a blank screen'],
  feature_request: ['can you add {wish}', 'it would be great if you supported {integration}', 'please add {wish}', 'any plans for a {integration} integration', 'feature request: {wish}', 'would love {wish} in the app'],
  human: ['talk to a human', 'can i speak to an agent', 'get me a real person', 'is there a phone number i can call', 'i need to talk to someone', 'transfer me to support staff'],
};

const VAGUE = ["it's not working", 'help', 'i have a problem with my account', 'something is wrong', 'please fix this', 'i need help with my order', 'this is ridiculous', 'hello?', 'are you there', 'why is this happening', 'ok', 'same problem as before'];
const PREFIX = ['', '', '', 'hi, ', 'hello, ', 'hey team, ', 'urgent: ', 'quick question: ', 'good morning, '];
const SUFFIX = ['', '', '', ' thanks', ' asap', ' please', '!!', ' thx', ' thank you'];

/**
 * @param {{ seed?: number }} [options]
 * @returns {{ labels: string[], next(): string, api(text: string): Promise<string>, truth(text: string): string, change(): string }}
 */
export function supportApi({ seed = 1 } = {}) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const answers = new Map();
  let changed = false;

  function fill(template) {
    return template.replace(/\{(\w+)\}/g, (_, k) => {
      if (k === 'order') return `#${10000 + Math.floor(rand() * 90000)}`;
      if (k === 'amount') return (5 + rand() * 195).toFixed(2);
      return pick(SLOTS[k]);
    });
  }

  function typo(text) {
    const words = text.split(' ');
    const i = Math.floor(rand() * words.length), w = words[i];
    if (w.length < 4) return text;
    const j = 1 + Math.floor(rand() * (w.length - 2));
    words[i] = w.slice(0, j) + w[j + 1] + w[j] + w.slice(j + 2);
    return words.join(' ');
  }

  // The label is fixed per text, as with a deterministic API: a hash picks among the candidates.
  const coin = (text, salt) => (hashString(text, salt) % 10_000) / 10_000;

  function next() {
    const u = rand();
    let text, label;
    if (u < 0.12) {
      text = pick(VAGUE);
      const options = ['human', 'bug', 'login', 'order_status', 'billing'];
      label = options[Math.floor(coin(text + rand().toFixed(1), 7) * options.length)];
    } else if (u < 0.22) {
      const a = pick(LABELS), b = pick(LABELS);
      text = `${fill(pick(TEMPLATES[a]))}${pick([' and ', '. also ', ', plus '])}${fill(pick(TEMPLATES[b]))}`;
      label = coin(text, 11) < 0.55 ? a : b;
    } else {
      label = pick(LABELS);
      text = fill(pick(TEMPLATES[label]));
      if (coin(text, 13) < 0.03) label = pick(LABELS); // an LLM is not perfectly consistent either
    }
    text = pick(PREFIX) + text + pick(SUFFIX);
    if (rand() < 0.08) text = typo(text);
    if (rand() < 0.2) text = text[0].toUpperCase() + text.slice(1);
    if (!answers.has(text)) answers.set(text, label);
    return text;
  }

  function truth(text) {
    const label = answers.get(text) ?? route(text);
    return changed && label === 'billing' ? 'refund' : label;
  }

  return {
    labels: LABELS,
    next,
    truth,
    api: async (text) => truth(text),
    change() { changed = true; return 'your API now files duplicate and unexpected charges under refund'; },
  };
}

/** A keyword router for texts the generator never produced, such as ones typed by hand. */
function route(text) {
  const t = text.toLowerCase();
  for (const [label, words] of [
    ['refund', ['refund', 'money back', 'return']], ['billing', ['charge', 'billed', 'invoice']],
    ['login', ['log in', 'password', 'sign in', '2fa', 'locked out']], ['order_status', ['where is', 'tracking', 'shipped', 'arrived']],
    ['change_address', ['address']], ['cancel', ['cancel', 'renew', 'close my account']], ['upgrade', ['upgrade', 'seats', 'plan']],
    ['bug', ['crash', 'error', 'broken', "won't load"]], ['feature_request', ['add ', 'support', 'integration']],
  ]) if (words.some((w) => t.includes(w))) return label;
  return 'human';
}
