/**
 * The UI half of the public contract, re-exported by `sdk.d.ts`.
 *
 * It sits in its own file because it is its own concern — the app's components,
 * declared over the props a contribution actually sets — and because the two
 * halves are read by different people: this one by whoever is laying a page
 * out, the other by whoever is talking to the host.
 *
 * The wrappers forward the rest of their props to their Radix roots, but
 * spelling Radix's generics out here would put a Radix version into the public
 * contract, and a plugin that never installs Radix could not typecheck against
 * it.
 */
import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react'

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
