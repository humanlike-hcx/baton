import { useRef, type ReactNode } from "react";
import { Dialog, Popover } from "radix-ui";
import { X } from "lucide-react";

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-backdrop" />
      <Dialog.Content className={`modal ${wide ? "diff-modal" : ""}`} aria-describedby={undefined}>
        <div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon" aria-label="关闭"><X size={20}/></Dialog.Close></div>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function ControlMenu({ label, children, trigger, disabled, open, onOpenChange, wide = false, align = "start", className = "" }: { label: string; children: ReactNode; trigger: ReactNode; disabled?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; wide?: boolean; align?: "start" | "end"; className?: string }) {
  const content = useRef<HTMLDivElement>(null);
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger className="control-trigger" aria-label={label} disabled={disabled}>{trigger}</Popover.Trigger>
    <Popover.Portal><Popover.Content ref={content} side="top" align={align} sideOffset={8} collisionPadding={12} onOpenAutoFocus={event => { event.preventDefault(); content.current?.focus({ preventScroll: true }); }} className={`control-menu ${wide ? "wide" : ""} ${className}`} aria-label={label}>{children}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}
