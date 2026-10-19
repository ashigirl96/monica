import { readFileSync, writeFileSync } from 'node:fs'

// addon-webgl は minify した lib しか配らないので、版を上げたら `bun patch @xterm/addon-webgl` の後にこれを流し、
// 合わなくなった置き換えを新しい変数名に直してから `bun patch --commit node_modules/@xterm/addon-webgl` する。
const dir = process.argv[2] ?? 'node_modules/@xterm/addon-webgl/lib'

const helpers = `
// monica: ghostty と同じく、はみ出す字形を縦横比を保って縮め、次の cell が空なら 2 cell の枠に置く。
var MONICA_SPAN_BIT=0x40000000;
function monicaSpanBit(line,x,cols,code,width,enabled){if(!enabled||width!==1||code<=255||x+1>=cols)return 0;var next=line.getCodePoint(x+1);if(next!==0&&next!==32)return 0;if(x>0&&line.getWidth(x-1)===1&&line.getCodePoint(x-1)>255)return 0;return MONICA_SPAN_BIT}
function monicaFit(a,i,g,d,span){var box=d.device.cell.width*span,s=Math.min(1,(box-1)/g.size.x,d.device.cell.height/g.size.y),w=g.size.x*s,h=g.size.y*s;a[i]=(box-w)/2;a[i+1]=s<1?(d.device.cell.height-h)/2:-g.offset.y+d.device.char.top;a[i+2]=w/d.device.canvas.width;a[i+3]=h/d.device.canvas.height;a[i+5]=g.texturePositionClipSpace.x;a[i+6]=g.texturePositionClipSpace.y;a[i+7]=g.sizeClipSpace.x;a[i+8]=g.sizeClipSpace.y}
`

type Edit = [string, string]

const files: Record<string, { prefixAfter: string; edits: Edit[] }> = {
  'addon-webgl.mjs': {
    prefixAfter: '',
    edits: [
      [
        'updateCell(t,r,s,a,o,n,L,T,h){this._updateCell(this._vertices.attributes,t,r,s,a,o,n,L,T,h)}',
        'updateCell(t,r,s,a,o,n,L,T,h,sp){this._updateCell(this._vertices.attributes,t,r,s,a,o,n,L,T,h,sp)}',
      ],
      ['_updateCell(t,r,s,a,o,n,L,T,h,d){', '_updateCell(t,r,s,a,o,n,L,T,h,d,sp){'],
      [
        'this._optionsService.rawOptions.rescaleOverlappingGlyphs&&Ze(a,h,S.size.x,this._dimensions.device.cell.width)&&(t[N+2]=(this._dimensions.device.cell.width-1)/this._dimensions.device.canvas.width)',
        'this._optionsService.rawOptions.rescaleOverlappingGlyphs&&Ze(a,h,S.size.x,this._dimensions.device.cell.width)&&monicaFit(t,N,S,this._dimensions,sp?2:1)',
      ],
      [
        '!(this._model.cells[F]===m&&',
        '(this.__monicaSpan=monicaSpanBit(T,E,s.cols,m,a.getWidth(),this._optionsService.rawOptions.rescaleOverlappingGlyphs),!(this._model.cells[F]===(m|this.__monicaSpan)&&',
      ],
      [
        'this._model.cells[F+3]===this._cellColorResolver.result.ext)&&(n0=!0,Q.length>1&&(m|=lt),this._model.cells[F]=m,',
        'this._model.cells[F+3]===this._cellColorResolver.result.ext))&&(n0=!0,Q.length>1&&(m|=lt),this._model.cells[F]=m|this.__monicaSpan,',
      ],
      [
        'this._cellColorResolver.result.ext,Q,R,o),d)',
        'this._cellColorResolver.result.ext,Q,R,o,this.__monicaSpan),d)',
      ],
    ],
  },
  'addon-webgl.js': {
    prefixAfter: '"use strict";',
    edits: [
      [
        'updateCell(t,e,i,s,r,a,o,n,h){this._updateCell(this._vertices.attributes,t,e,i,s,r,a,o,n,h)}',
        'updateCell(t,e,i,s,r,a,o,n,h,sp){this._updateCell(this._vertices.attributes,t,e,i,s,r,a,o,n,h,sp)}',
      ],
      ['_updateCell(t,e,i,s,a,o,d,c,_,Q){', '_updateCell(t,e,i,s,a,o,d,c,_,Q,sp){'],
      [
        'this._optionsService.rawOptions.rescaleOverlappingGlyphs&&(0,n.allowRescaling)(s,_,h.size.x,this._dimensions.device.cell.width)&&(t[L+2]=(this._dimensions.device.cell.width-1)/this._dimensions.device.canvas.width)',
        'this._optionsService.rawOptions.rescaleOverlappingGlyphs&&(0,n.allowRescaling)(s,_,h.size.x,this._dimensions.device.cell.width)&&monicaFit(t,L,h,this._dimensions,sp?2:1)',
      ],
      [
        '(this._model.cells[M]!==p||',
        '(this.__monicaSpan=monicaSpanBit(o,f,i.cols,p,m.getWidth(),this._optionsService.rawOptions.rescaleOverlappingGlyphs),this._model.cells[M]!==(p|this.__monicaSpan)||',
      ],
      [
        'A=!0,u.length>1&&(p|=c.COMBINED_CHAR_BIT_MASK),this._model.cells[M]=p,',
        'A=!0,u.length>1&&(p|=c.COMBINED_CHAR_BIT_MASK),this._model.cells[M]=p|this.__monicaSpan,',
      ],
      [
        'this._cellColorResolver.result.ext,u,g,s),h)',
        'this._cellColorResolver.result.ext,u,g,s,this.__monicaSpan),h)',
      ],
    ],
  },
}

for (const [name, { prefixAfter, edits }] of Object.entries(files)) {
  const path = `${dir}/${name}`
  let src = readFileSync(path, 'utf8')
  for (const [from, to] of edits) {
    const count = src.split(from).length - 1
    if (count !== 1)
      throw new Error(`${name}: expected 1 match, got ${count}: ${from.slice(0, 60)}`)
    src = src.replace(from, () => to)
  }
  if (prefixAfter) {
    const at = src.indexOf(prefixAfter)
    if (at < 0) throw new Error(`${name}: anchor not found`)
    src = src.slice(0, at + prefixAfter.length) + helpers + src.slice(at + prefixAfter.length)
  } else {
    src = helpers + src
  }
  writeFileSync(path, src)
  console.log(`patched ${name}`)
}
