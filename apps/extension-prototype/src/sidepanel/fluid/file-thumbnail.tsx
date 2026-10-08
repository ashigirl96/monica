// PROTOTYPE: 添付を入れないので、本家の file-thumbnail（pdfjs-dist を jsdelivr から読む）を写さず、同じ形の stub に置き換えた。
import { cn } from './lib/utils'

interface FileThumbnailProps {
  file: File
  size: number
  radius?: number
  className?: string
}

function FileThumbnail({ file, size, className }: FileThumbnailProps) {
  return (
    <div
      className={cn('flex items-center justify-center rounded-lg bg-accent text-[10px]', className)}
      style={{ width: size, height: size }}
    >
      {file.name}
    </div>
  )
}

export { FileThumbnail }
export type { FileThumbnailProps }
