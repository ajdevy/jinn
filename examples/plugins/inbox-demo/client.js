/**
 * The dashboard half of the reference plugin.
 *
 * Plain ESM, loaded straight off disk with no build step, which is the one
 * constraint that shapes every line here: JSX SYNTAX IS NOT AVAILABLE. Nothing
 * transpiles this file, so elements are built by calling `jsx()` and `jsxs()`
 * from the SDK. `jsx` takes one child, `jsxs` takes an array of them.
 *
 * The three imports below are the complete list a disk plugin may write:
 * `@jinn/plugin-sdk`, `react`, and `react/jsx-runtime`. Anything else is
 * rejected by the loader with a named error, and React in particular has to come
 * from here rather than from a copy of its own, or every hook would throw.
 */
import { AREAS, React, jsx, jsxs } from '@jinn/plugin-sdk'

const STATE_COLOR = {
  pending: 'var(--text-secondary)',
  approved: 'var(--system-green)',
  rejected: 'var(--system-red)',
}

export default {
  id: 'inbox-demo',
  name: 'Inbox Demo',

  register(ctx) {
    /**
     * The message list, kept live.
     *
     * `ctx.backend` calls this plugin's own routes; it takes a path relative to
     * the mount and supplies the plugin id itself, so one plugin can never call
     * another's. `ctx.events` is the same idea for the event stream: it opens
     * this plugin's channel and hands back an unsubscribe, which is exactly what
     * an effect wants to return.
     */
    function useMessages() {
      const [messages, setMessages] = React.useState([])

      const refresh = React.useCallback(async () => {
        const response = await ctx.backend('/messages')
        if (!response.ok) return
        const body = await response.json()
        setMessages(Array.isArray(body.messages) ? body.messages : [])
      }, [])

      React.useEffect(() => {
        void refresh()
        // Every event the backend emits is a reason to re-read: an arrival from
        // the watcher, and a decision made in another tab alike.
        return ctx.events(() => void refresh())
      }, [refresh])

      return { messages, refresh }
    }

    async function decide(id, verdict) {
      await ctx.backend(`/${verdict}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    }

    function DecideButton({ label, tint, onPress }) {
      return jsx('button', {
        type: 'button',
        onClick: onPress,
        // Tokens only, and no border at rest: a soft tinted fill is how the app
        // separates a control from its surface.
        style: {
          height: 34,
          padding: '0 14px',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          background: `color-mix(in srgb, ${tint} 12%, transparent)`,
          color: tint,
          font: 'inherit',
          fontSize: 'var(--text-footnote)',
          fontWeight: 'var(--weight-medium)',
          cursor: 'pointer',
        },
        children: label,
      })
    }

    function MessageRow({ message }) {
      return jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          minHeight: 56,
          padding: '0 var(--space-3)',
        },
        children: [
          jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
            children: [
              jsx('span', {
                style: {
                  fontSize: 'var(--text-subheadline)',
                  fontWeight: 'var(--weight-medium)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                children: message.subject,
              }),
              jsx('span', {
                style: { fontSize: 'var(--text-caption1)', color: STATE_COLOR[message.state] },
                children: message.state,
              }),
            ],
          }),
          message.state === 'pending' &&
            jsxs('div', {
              style: { display: 'flex', gap: 'var(--space-2)' },
              children: [
                jsx(DecideButton, {
                  label: 'Approve',
                  tint: 'var(--system-green)',
                  onPress: () => void decide(message.id, 'approve'),
                }),
                jsx(DecideButton, {
                  label: 'Reject',
                  tint: 'var(--system-red)',
                  onPress: () => void decide(message.id, 'reject'),
                }),
              ],
            }),
        ],
      })
    }

    function InboxPage() {
      const { messages } = useMessages()

      return jsxs('div', {
        style: { maxWidth: 840, margin: '0 auto', padding: 'var(--space-6) var(--space-5)' },
        children: [
          jsx('h1', {
            style: {
              fontFamily: 'var(--font-display)',
              fontSize: 'var(--text-title1)',
              fontWeight: 700,
              color: 'var(--text-primary)',
            },
            children: 'Inbox Demo',
          }),
          jsx('p', {
            style: {
              marginTop: 'var(--space-1)',
              fontSize: 'var(--text-footnote)',
              color: 'var(--text-tertiary)',
            },
            children: `${messages.length} ${messages.length === 1 ? 'message' : 'messages'}. Drop a file in the watched inbox to add one.`,
          }),
          jsx('div', {
            style: {
              marginTop: 'var(--space-5)',
              borderRadius: 'var(--radius-xl)',
              background: 'var(--bg-secondary)',
              boxShadow: 'var(--shadow-card)',
              padding: 'var(--space-1)',
            },
            // The third argument to jsx() is the key, which is how a no-build
            // plugin writes what `key={...}` would have written.
            children: messages.map((message) => jsx(MessageRow, { message }, message.id)),
          }),
        ],
      })
    }

    /** The status bar chip. Nothing pending is nothing to say, so it renders
     *  nothing rather than a zero. */
    function PendingChip() {
      const { messages } = useMessages()
      const pending = messages.filter((message) => message.state === 'pending').length
      if (pending === 0) return null

      return jsx('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          height: 34,
          padding: '0 10px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--fill-tertiary)',
          fontSize: 'var(--text-caption2)',
          color: 'var(--text-secondary)',
        },
        children: `${pending} pending`,
      })
    }

    // All three v1 surfaces, registered in one batch so unloading takes them
    // down together. The ids are local: the host namespaces them under this
    // plugin, which is why two plugins can both contribute a "page".
    ctx.contributeMany([
      {
        id: 'page',
        area: AREAS.routes,
        data: { path: '/inbox-demo' },
        render: () => jsx(InboxPage, {}),
      },
      {
        id: 'nav',
        area: AREAS.sidebarNav,
        // No icon: a disk plugin cannot import an icon library, so the host
        // renders contributed rows with its own fallback glyph.
        data: { href: '/inbox-demo', label: 'Inbox Demo' },
      },
      {
        id: 'chip',
        area: AREAS.statusBarRight,
        render: () => jsx(PendingChip, {}),
      },
    ])
  },
}
