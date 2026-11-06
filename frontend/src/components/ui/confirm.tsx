// 通用确认模态（shadcn Dialog 封装）：危险操作（删除等）一律走它，不再用原生 confirm
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export function ConfirmDialog({
  open, title, desc, confirmText = "确定", danger = false, busy = false, onConfirm, onCancel,
}: {
  open: boolean; title: string; desc?: string;
  confirmText?: string; danger?: boolean; busy?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {desc && <DialogDescription>{desc}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
            {busy ? "处理中…" : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
