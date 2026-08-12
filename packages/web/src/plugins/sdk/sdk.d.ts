/**
 * The public type contract of `@jinn/plugin-sdk`, version 1.1.0.
 *
 * Hand-authored, and deliberately never generated from `index.ts`. A derived
 * `.d.ts` inlines the app's own import paths into the public API, so renaming
 * an internal module becomes a silent breaking change for every plugin built
 * against it. The only modules named here are ones a plugin author can install.
 *
 * A test holds this file in exact two-way sync with the runtime barrel: every
 * name declared below is exported by `index.ts`, and every name `index.ts`
 * exports is declared below.
 */
import type * as ReactModule from 'react'
import type {
  ButtonHTMLAttributes,
  ComponentType,
  ElementType,
  HTMLAttributes,
  ReactElement,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { ClassValue } from 'clsx'

/** The contract this file describes. A plugin can refuse to load against a
 *  version it predates. */
export declare const SDK_CONTRACT_VERSION: '1.1.0'

/* React, the app's own instances. A plugin that resolved a second React would
 * get a second dispatcher and every hook it called would throw, so these are
 * the mechanism rather than a convenience. */
export declare const React: typeof ReactModule
export declare function jsx(type: ElementType, props: unknown, key?: string): ReactElement
export declare function jsxs(type: ElementType, props: unknown, key?: string): ReactElement
export declare const Fragment: ElementType

/** The app's single query client, with its cache and defaults already set. */
export declare const queryClient: QueryClient

/** Merge Tailwind class names; the last conflicting utility wins. */
export declare function cn(...inputs: ClassValue[]): string

/* The UI primitives are declared over the props a contribution actually sets.
 * The wrappers forward the rest to their Radix roots, but spelling Radix's
 * generics out here would put a Radix version into the public contract, and a
 * plugin that never installs Radix could not typecheck against it. */
interface Styled {
  className?: string
  children?: ReactNode
}

type DivProps = HTMLAttributes<HTMLDivElement>

export declare const Button: ComponentType<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
    size?: 'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
    asChild?: boolean
  }
>

export declare const Card: ComponentType<DivProps>
export declare const CardHeader: ComponentType<DivProps>
export declare const CardTitle: ComponentType<DivProps>
export declare const CardDescription: ComponentType<DivProps>
export declare const CardContent: ComponentType<DivProps>
export declare const CardFooter: ComponentType<DivProps>

export declare const Dialog: ComponentType<{
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  modal?: boolean
  children?: ReactNode
}>
export declare const DialogTrigger: ComponentType<Styled & { asChild?: boolean }>
export declare const DialogContent: ComponentType<
  Styled & { showCloseButton?: boolean; overlayClassName?: string }
>
export declare const DialogHeader: ComponentType<DivProps>
export declare const DialogTitle: ComponentType<Styled>
export declare const DialogDescription: ComponentType<Styled>
export declare const DialogFooter: ComponentType<DivProps & { showCloseButton?: boolean }>
export declare const DialogClose: ComponentType<Styled & { asChild?: boolean }>

export declare const Select: ComponentType<{
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  disabled?: boolean
  children?: ReactNode
}>
export declare const SelectTrigger: ComponentType<Styled & { disabled?: boolean }>
export declare const SelectValue: ComponentType<{ placeholder?: ReactNode; className?: string }>
export declare const SelectContent: ComponentType<Styled>
export declare const SelectItem: ComponentType<Styled & { value: string; disabled?: boolean }>

export declare const Skeleton: ComponentType<
  DivProps & { width?: number | string; height?: number | string }
>

export declare const Switch: ComponentType<{
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  id?: string
  className?: string
}>

export declare const Tabs: ComponentType<
  Styled & {
    value?: string
    defaultValue?: string
    onValueChange?: (value: string) => void
    orientation?: 'horizontal' | 'vertical'
  }
>
export declare const TabsList: ComponentType<Styled & { variant?: 'default' | 'line' }>
export declare const TabsTrigger: ComponentType<Styled & { value: string; disabled?: boolean }>
export declare const TabsContent: ComponentType<Styled & { value: string }>

export declare const Textarea: ComponentType<TextareaHTMLAttributes<HTMLTextAreaElement>>

/** The v1 areas. The values are the contract — they appear in manifests and in
 *  the registry's keys — and the property names are only an alias. */
export declare const AREAS: {
  readonly routes: 'routes'
  readonly sidebarNav: 'sidebar.nav'
  readonly statusBarRight: 'statusbar.right'
  readonly todoDetailActions: 'todo.detail.actions'
  readonly todoDetailSections: 'todo.detail.sections'
}

export type AreaId =
  | 'routes'
  | 'sidebar.nav'
  | 'statusbar.right'
  | 'todo.detail.actions'
  | 'todo.detail.sections'

export type GatewayStatus = 'connected' | 'disconnected'

/** The readonly tier: what the app is currently showing. */
export interface HostState {
  readonly activeSession: string | null
  readonly gatewayStatus: GatewayStatus
}

/** A gateway frame as a plugin sees it. Narrow `payload` yourself; the host's
 *  typed event union lives in a package a plugin cannot install. */
export interface HostEvent {
  readonly event: string
  readonly payload: unknown
}

export type HostEventHandler = (frame: HostEvent) => void

export type HostNotifyLevel = 'info' | 'warning' | 'error'

/* The typed verb tier. Every payload below is spelled out rather than imported:
 * the gateway's own Todo and session types live in a package a plugin cannot
 * install, and naming them would put the app's internals into this contract.
 *
 * v1 grants every verb; the union below is the vocabulary a grant is written in. */
export type PluginHostVerb =
  | 'todos.list'
  | 'todos.create'
  | 'todos.comment'
  | 'sessions.spawn'
  | 'employees.list'
  | 'notify'

/** The eight states a Todo can be in, as the gateway spells them. */
export type HostTodoStatus =
  | 'backlog'
  | 'assigned'
  | 'executing'
  | 'in_review'
  | 'done'
  | 'blocked'
  | 'escalated'
  | 'cancelled'

/** A Todo as the list verb returns it: the columns a board renders. */
export interface HostTodo {
  id: string
  title: string
  status: HostTodoStatus
  assignee: string | null
  department: string | null
  parentId: string | null
  updatedAt: string
}

export interface HostTodoFilter {
  status?: HostTodoStatus
  assignee?: string
  /** Only parentless Todos — the objective view, without their sub-tasks. */
  rootsOnly?: boolean
  /** Defaults to 20; the gateway caps the page at 100. */
  limit?: number
}

/** What a plugin may set when it mints a Todo. Provenance is absent by design:
 *  the gateway stamps it, so a plugin cannot claim another author. */
export interface HostTodoDraft {
  title: string
  body?: string
  assignee?: string
  department?: string
  parentId?: string
  /** 0 (highest) to 3 (lowest); the gateway defaults to 2. */
  priority?: number
}

export interface HostTodoComment {
  id: string
  workItemId: string
  author: string
  body: string
  createdAt: string
}

export interface HostSessionSpawn {
  prompt: string
  /** An employee from the org. Omitted, the session runs on gateway defaults. */
  employee?: string
  engine?: string
  model?: string
}

export interface HostSession {
  id: string
  engine: string
  employee: string | null
  status: string
  title: string | null
}

export interface HostEmployee {
  name: string
  displayName: string
  department: string
  rank: string
  engine: string
  model: string
  /** The persona's first line, when short enough to be a label. */
  role?: string
}

export interface PluginHostTodos {
  list(filter?: HostTodoFilter): Promise<HostTodo[]>
  create(draft: HostTodoDraft): Promise<HostTodo>
  comment(todoId: string, body: string): Promise<HostTodoComment>
}

export interface PluginHostSessions {
  /** Start a session and its first turn. Resolves once the row exists. */
  spawn(request: HostSessionSpawn): Promise<HostSession>
}

export interface PluginHostEmployees {
  list(): Promise<HostEmployee[]>
}

export interface PluginHost {
  readonly state: {
    /** Stable identity between publishes, so it can back `useSyncExternalStore`. */
    getSnapshot(): HostState
    subscribe(listener: (state: HostState) => void): () => void
  }
  /** Subscribe to one gateway event type; returns the unsubscribe. Handlers are
   *  isolated from each other: one that throws does not stop the rest. */
  onEvent(type: string, handler: HostEventHandler): () => void
  /** Navigate the app. Throws a `PluginSdkError` if called before the app has
   *  mounted, rather than dropping the call. */
  navigate(path: string): void
  /** Show a notification, or log it when no surface is mounted. Throws only
   *  when the verb itself is refused, never for want of a surface. */
  notify(message: string, level?: HostNotifyLevel): void
  todos: PluginHostTodos
  sessions: PluginHostSessions
  employees: PluginHostEmployees
}

export declare const host: PluginHost

/** Every failure the SDK raises, so a plugin can tell an SDK problem from one
 *  of its own. */
export declare class PluginSdkError extends Error {
  constructor(message: string)
}

/** Thrown when a verb is refused, so a plugin can degrade rather than break. */
export declare class PluginHostDeniedError extends PluginSdkError {
  readonly verb: PluginHostVerb
  constructor(verb: PluginHostVerb)
}
