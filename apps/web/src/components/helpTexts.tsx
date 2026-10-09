// The longer explanations behind the circled "?" icons. Plain words and everyday comparisons
// first; the technical term second.
import { Help } from './ui'

export function MethodHelp() {
  return (
    <Help title="GET or POST: how the question travels" wide>
      <p><b className="font-semibold">POST is a sealed envelope.</b> The address stays plain and the question rides inside, in the <i>body</i> (the JSON box below). Like signing in to a website: your password never shows in the address bar. Most chatbots are asked this way.</p>
      <p><b className="font-semibold">GET is a postcard.</b> There is no body: everything is written in the address itself, like a Google search: <code>google.com/search?q=production+version</code>. With GET, the Body box is ignored.</p>
      <p><b className="font-semibold">Which one?</b> The one your bot expects. A pasted curl command already says, and Assay fills it in. Pick the wrong one and the bot answers <code>405 Method Not Allowed</code>.</p>
    </Help>
  )
}

export function CleanupMethodHelp() {
  return (
    <Help title="DELETE or POST for the clean-up" wide>
      <p><b className="font-semibold">DELETE</b> asks the bot to remove something: here, the test conversation it just saved. Most bots delete a chat this way, e.g. <code>DELETE /api/conversations/42</code>.</p>
      <p><b className="font-semibold">POST</b> is for bots whose developer chose a “delete” action you send to, e.g. <code>POST /api/chat/delete</code>.</p>
      <p>To find out, delete a chat in the bot with DevTools → Network open and look at the <i>Method</i> column of that request.</p>
    </Help>
  )
}

export function ConnectionHelp() {
  return (
    <Help title="Chatbot, connection, version" wide>
      <p>Assay files a bot at three levels, like a filing cabinet:</p>
      <ul className="list-disc space-y-1 pl-4">
        <li><b className="font-semibold">Chatbot</b>: the product as a whole, e.g. <i>Acme Support Bot</i>. It holds the datasets, gates and runs.</li>
        <li><b className="font-semibold">Connection</b>: one place you can reach it, with its address and setup, e.g. <i>Acme - local dev (:8120)</i>, <i>Acme - test copy</i>, <i>Acme - server</i>. Compare them to see whether the deployed bot behaves like your copy.</li>
        <li><b className="font-semibold">Version</b>: what is inside the connection right now: model, prompt, retriever. When you change those, save a new <i>version</i> of the same connection, not a new connection; the chatbot’s page then compares versions.</li>
      </ul>
    </Help>
  )
}

export function ParallelHelp() {
  return (
    <Help title="Why not ask everything at once?" wide>
      <p><b className="font-semibold">Think of a restaurant kitchen.</b> Ten orders arrive at once. The kitchen does not cook faster, so each dish waits its turn. Time “order to table” and you are timing the <i>queue</i>, not the cooking. Overload it and some orders get dropped, and the other diners (real users of a shared bot) wait too.</p>
      <ul className="list-disc space-y-1 pl-4">
        <li><b className="font-semibold">Total cost is the same</b>: 12 questions are 12 answers either way. Higher only spends it faster.</li>
        <li><b className="font-semibold">Speed figures get worse</b>: answers wait for each other, so a 5 s answer can measure 20 s. Runs at different settings cannot be compared on speed, and a speed gate may fail for the wrong reason.</li>
        <li><b className="font-semibold">Errors that are not the bot’s fault</b>: providers limit calls per minute; the excess comes back “rate limited” and counts as a failure.</li>
        <li><b className="font-semibold">The spend cap reacts late</b>: questions already sent cannot be recalled, so up to that many more answers are paid for.</li>
      </ul>
      <p><b className="font-semibold">Rule of thumb:</b> 1 when speed matters, 2–4 for everyday runs, 8 or more only for large datasets on a bot built for it.</p>
    </Help>
  )
}
