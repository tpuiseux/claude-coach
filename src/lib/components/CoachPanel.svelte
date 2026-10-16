<script lang="ts">
  import { tick } from "svelte";
  import { base } from "$app/paths";
  import type {
    ChangePreview,
    CoachChatMessage,
    CoachEvent,
    CoachProposal,
    WorkoutSnapshot,
  } from "../coach.js";
  import { renderMarkdown } from "../markdown.js";
  import { formatDuration } from "../utils.js";

  interface Props {
    planId: string;
    /** After a proposal is applied or undone - the page reloads the plan. */
    onPlanChanged: () => Promise<void> | void;
  }

  let { planId, onPlanChanged }: Props = $props();

  let open = $state(false);
  let loaded = $state(false);
  let configured = $state(true);
  let messages = $state<CoachChatMessage[]>([]);
  let proposals = $state<Record<number, CoachProposal>>({});
  let draft = $state("");
  let sending = $state(false);
  /** What the coach is doing right now, while it answers. */
  let status = $state<string | null>(null);
  let errorText = $state<string | null>(null);
  let busyProposal = $state<number | null>(null);

  let listEl = $state<HTMLElement | null>(null);
  let inputEl = $state<HTMLTextAreaElement | null>(null);

  const url = $derived(`${base}/plans/${planId}/coach`);

  async function scrollToEnd() {
    await tick();
    listEl?.scrollTo({ top: listEl.scrollHeight });
  }

  async function load() {
    errorText = null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load the conversation (${res.status})`);
      const data = await res.json();
      configured = data.configured;
      messages = data.messages;
      proposals = Object.fromEntries((data.proposals as CoachProposal[]).map((p) => [p.id, p]));
      loaded = true;
      await scrollToEnd();
    } catch (err) {
      errorText = err instanceof Error ? err.message : "Couldn't load the conversation.";
    }
  }

  async function toggle() {
    open = !open;
    if (open) {
      if (!loaded) await load();
      await tick();
      inputEl?.focus();
    }
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    draft = "";
    errorText = null;
    sending = true;
    status = "Thinking…";
    messages.push({ id: -Date.now(), role: "user", text, activity: [], proposalIds: [] });
    const reply: CoachChatMessage = {
      id: -Date.now() - 1,
      role: "assistant",
      text: "",
      activity: [],
      proposalIds: [],
    };
    messages.push(reply);
    // The pushed object is proxied; edit it through the array.
    const replyIndex = messages.length - 1;
    await scrollToEnd();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `The coach couldn't answer (${res.status}).`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) handleEvent(JSON.parse(line) as CoachEvent, replyIndex);
        }
        await scrollToEnd();
      }
    } catch (err) {
      errorText = err instanceof Error ? err.message : "The coach couldn't answer.";
    } finally {
      sending = false;
      status = null;
      // An empty reply bubble (error before any text) isn't worth keeping.
      const r = messages[replyIndex];
      if (r && !r.text && r.proposalIds.length === 0) messages.splice(replyIndex, 1);
      await scrollToEnd();
    }
  }

  function handleEvent(event: CoachEvent, replyIndex: number) {
    const reply = messages[replyIndex];
    switch (event.type) {
      case "text":
        reply.text += event.delta;
        status = null;
        break;
      case "activity":
        reply.activity.push(event.label);
        status = `${event.label}…`;
        break;
      case "proposal":
        proposals[event.proposal.id] = event.proposal;
        reply.proposalIds.push(event.proposal.id);
        break;
      case "error":
        errorText = event.message;
        break;
      case "done":
        status = null;
        break;
    }
  }

  async function answer(proposal: CoachProposal, action: "apply" | "reject" | "undo") {
    busyProposal = proposal.id;
    errorText = null;
    try {
      const res = await fetch(`${url}/proposals/${proposal.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
      proposals[proposal.id] = body.proposal;
      if (action !== "reject") await onPlanChanged();
    } catch (err) {
      errorText = err instanceof Error ? err.message : "Something went wrong.";
    } finally {
      busyProposal = null;
    }
  }

  async function newConversation() {
    if (sending) return;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) {
      messages = [];
      proposals = {};
      errorText = null;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function shortDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  function describe(w: WorkoutSnapshot): string {
    const length = w.durationMinutes ? ` · ${formatDuration(w.durationMinutes)}` : "";
    return `${w.name}${length}`;
  }

  const OP_LABELS: Record<ChangePreview["op"], string> = {
    move: "Move",
    edit: "Change",
    add: "Add",
    delete: "Remove",
  };

  const STATUS_LABELS: Record<CoachProposal["status"], string> = {
    pending: "",
    applied: "Applied",
    rejected: "Rejected",
    undone: "Undone",
  };

  const SUGGESTIONS = [
    "How did my week go?",
    "Am I on track for my goal time?",
    "My hamstring is sore today - what should I change?",
  ];
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && open && (open = false)} />

{#if !open}
  <button class="coach-fab" onclick={toggle} aria-label="Talk to the coach">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
    Coach
  </button>
{/if}

{#if open}
  <aside class="coach-panel" aria-label="Coach">
    <header>
      <h2>Coach</h2>
      <div class="header-actions">
        {#if messages.length > 0}
          <button class="link" onclick={newConversation} disabled={sending}>New conversation</button
          >
        {/if}
        <button class="close" onclick={toggle} aria-label="Close">×</button>
      </div>
    </header>

    <div class="messages" bind:this={listEl}>
      {#if !configured}
        <p class="empty">
          The coach isn't set up on this server yet: it needs an Anthropic API key (<code
            >ANTHROPIC_API_KEY</code
          >).
        </p>
      {:else if loaded && messages.length === 0}
        <div class="empty">
          <p>
            Ask about your training, your week or the race. The coach can read your plan, your
            Garmin sessions, your feedback and your recovery, and suggest changes to the plan -
            nothing changes until you apply them.
          </p>
          <div class="suggestions">
            {#each SUGGESTIONS as s (s)}
              <button onclick={() => ((draft = s), inputEl?.focus())}>{s}</button>
            {/each}
          </div>
        </div>
      {/if}

      {#each messages as m (m.id)}
        <div class="message {m.role}">
          {#if m.role === "assistant"}
            {#if m.text}
              <div class="bubble markdown">{@html renderMarkdown(m.text)}</div>
            {/if}
            {#each m.proposalIds as pid (pid)}
              {@const p = proposals[pid]}
              {#if p}
                <div class="proposal" class:settled={p.status !== "pending"}>
                  <div class="proposal-head">
                    <span class="proposal-title">{p.summary}</span>
                    {#if p.status !== "pending"}
                      <span class="proposal-status">{STATUS_LABELS[p.status]}</span>
                    {/if}
                  </div>
                  <ul>
                    {#each p.changes as c, i (i)}
                      <li>
                        <span class="op {c.op}">{OP_LABELS[c.op]}</span>
                        <div class="change">
                          {#if c.op === "move" && c.before && c.after}
                            <div>{describe(c.before)}</div>
                            <div class="muted">
                              {shortDate(c.before.date)} → {shortDate(c.after.date)}
                            </div>
                          {:else if c.op === "edit" && c.before && c.after}
                            <div>
                              {#if c.before.name !== c.after.name}
                                <s>{c.before.name}</s> → {describe(c.after)}
                              {:else}
                                {describe(c.after)}
                              {/if}
                            </div>
                            <div class="muted">
                              {shortDate(c.after.date)}
                              {#if c.before.durationMinutes !== c.after.durationMinutes}
                                · {formatDuration(c.before.durationMinutes ?? 0)} → {formatDuration(
                                  c.after.durationMinutes ?? 0
                                )}
                              {/if}
                            </div>
                          {:else if c.after}
                            <div>{describe(c.after)}</div>
                            <div class="muted">{shortDate(c.after.date)}</div>
                          {:else if c.before}
                            <div><s>{describe(c.before)}</s></div>
                            <div class="muted">{shortDate(c.before.date)}</div>
                          {/if}
                          {#if c.reason}<div class="reason">{c.reason}</div>{/if}
                        </div>
                      </li>
                    {/each}
                  </ul>
                  <div class="proposal-actions">
                    {#if p.status === "pending"}
                      <button
                        class="primary"
                        disabled={busyProposal === p.id}
                        onclick={() => answer(p, "apply")}>Apply</button
                      >
                      <button disabled={busyProposal === p.id} onclick={() => answer(p, "reject")}
                        >Reject</button
                      >
                    {:else if p.status === "applied"}
                      <button disabled={busyProposal === p.id} onclick={() => answer(p, "undo")}
                        >Undo</button
                      >
                    {/if}
                  </div>
                </div>
              {/if}
            {/each}
          {:else}
            <div class="bubble">{m.text}</div>
          {/if}
        </div>
      {/each}

      {#if status}
        <div class="status" role="status">{status}</div>
      {/if}
      {#if errorText}
        <div class="error" role="alert">{errorText}</div>
      {/if}
    </div>

    <form
      class="composer"
      onsubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        bind:this={inputEl}
        bind:value={draft}
        onkeydown={onKeydown}
        rows="2"
        placeholder="Message the coach…"
        disabled={!configured}
      ></textarea>
      <button type="submit" class="primary" disabled={sending || !draft.trim() || !configured}>
        Send
      </button>
    </form>
  </aside>
{/if}

<style>
  .coach-fab {
    position: fixed;
    right: 1rem;
    bottom: 3.5rem;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.65rem 1rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    background: var(--accent);
    color: var(--bg-primary);
    font-weight: 600;
    font-size: 0.9rem;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }

  .coach-fab svg {
    width: 18px;
    height: 18px;
  }

  .coach-panel {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 120;
    width: min(440px, 100vw);
    height: 100dvh;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border-subtle);
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.35);
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  h2 {
    font-size: 1rem;
    font-weight: 700;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .link {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .link:hover {
    color: var(--text-primary);
  }

  .close {
    width: 40px;
    height: 40px;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 1.5rem;
  }

  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .empty {
    color: var(--text-secondary);
    font-size: 0.85rem;
    line-height: 1.5;
  }

  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.9rem;
  }

  .suggestions button {
    text-align: left;
    padding: 0.55rem 0.75rem;
    border-radius: 10px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-primary);
    font-size: 0.82rem;
  }

  .suggestions button:hover {
    background: var(--bg-tertiary);
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .message.user {
    align-items: flex-end;
  }

  .bubble {
    max-width: 92%;
    padding: 0.6rem 0.8rem;
    border-radius: 12px;
    font-size: 0.88rem;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .user .bubble {
    background: var(--bg-elevated);
    border-bottom-right-radius: 4px;
  }

  .assistant .bubble {
    background: var(--bg-tertiary);
    border-bottom-left-radius: 4px;
    white-space: normal;
  }

  .markdown :global(p) {
    margin: 0 0 0.5rem;
  }

  .markdown :global(p:last-child),
  .markdown :global(ul:last-child),
  .markdown :global(ol:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 0.5rem;
    padding-left: 1.2rem;
  }

  .markdown :global(li) {
    margin-bottom: 0.2rem;
  }

  .markdown :global(code) {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.8rem;
  }

  .proposal {
    border: 1px solid var(--accent);
    border-radius: 12px;
    padding: 0.75rem;
    background: var(--bg-primary);
  }

  .proposal.settled {
    border-color: var(--border-medium);
  }

  .proposal-head {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .proposal-title {
    font-weight: 600;
    font-size: 0.88rem;
  }

  .proposal-status {
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .proposal ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .proposal li {
    display: flex;
    gap: 0.6rem;
    font-size: 0.82rem;
  }

  .op {
    flex-shrink: 0;
    width: 4.2rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    padding-top: 0.1rem;
  }

  .change {
    min-width: 0;
  }

  .muted {
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .reason {
    color: var(--text-muted);
    font-size: 0.76rem;
    margin-top: 0.15rem;
  }

  .proposal-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .proposal-actions:empty {
    display: none;
  }

  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
    font-weight: 600;
  }

  .proposal-actions button,
  .composer button {
    padding: 0.45rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-primary);
    font-size: 0.82rem;
  }

  .proposal-actions button.primary,
  .composer button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .status {
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .error {
    font-size: 0.82rem;
    padding: 0.5rem 0.7rem;
    border-radius: 8px;
    background: #3a1414;
    color: #f87171;
  }

  .composer {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    padding: 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }

  textarea {
    flex: 1;
    resize: none;
    max-height: 30vh;
    padding: 0.55rem 0.7rem;
    border-radius: 10px;
    border: 1px solid var(--border-medium);
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.88rem;
  }

  @media (max-width: 800px) {
    .coach-panel {
      width: 100vw;
      border-left: none;
    }

    .coach-fab {
      bottom: 1rem;
    }

    textarea {
      font-size: 16px; /* no zoom-on-focus on iOS */
    }

    .composer button,
    .proposal-actions button {
      min-height: 44px;
    }
  }
</style>
