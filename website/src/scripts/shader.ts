// The one fullscreen canvas behind every page. Two passes: a slow domain-warped field drawn small, then a
// full-size pass that colours it and draws the 7 as signed distance fields, so the edges stay sharp at any zoom.

export type Mood = 'night' | 'alert' | 'safe' | 'deep' | 'dawn' | 'day';

// The mark, in its own 32-unit box, y down. Exact from Logo.tsx.
const FOCUS = [11.4, 15.6]; // the empty ink under the bar, left of the stroke: where the camera goes through

const VERT = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v=p*.5+.5; gl_Position=vec4(p,0.,1.); }`;

const FIELD = (octaves: number) => `#version 300 es
precision highp float; precision highp int;
uniform vec2 R; uniform float T, Z; uniform vec3 P;
out vec4 o;
uvec2 pcg(uvec2 v){
  v=v*1664525u+1013904223u; v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u;
  v.x+=v.y*1664525u; v.y+=v.x*1664525u; v^=v>>16u; return v;
}
vec2 g(ivec2 i){ uvec2 h=pcg(uvec2(i+32768)); float a=float(h.x>>20u)*.00153398; return vec2(cos(a),sin(a)); }
float n(vec2 p){
  vec2 b=floor(p), f=p-b, u=f*f*f*(f*(f*6.-15.)+10.); ivec2 i=ivec2(b);
  return mix(mix(dot(g(i),f),dot(g(i+ivec2(1,0)),f-vec2(1,0)),u.x),
             mix(dot(g(i+ivec2(0,1)),f-vec2(0,1)),dot(g(i+ivec2(1,1)),f-vec2(1,1)),u.x),u.y);
}
float fbm(vec2 p,int c){ float a=.5,s=0.; for(int i=0;i<c;i++){ s+=a*n(p); p=mat2(.8,.6,-.6,.8)*p*2.03; a*=.5; } return s; }
void main(){
  vec2 p=(gl_FragCoord.xy-.5*R)/R.y*Z;
  vec2 d=p-P.xy; p+=P.z*exp(-dot(d,d)*6.)*vec2(-d.y,d.x);
  const vec2 s=vec2(.5269,.8499);                 // along the slash, so the ribbons lean with the 7
  vec2 a=vec2(dot(p,s),dot(p,vec2(s.y,-s.x)))*vec2(.4,1.3);
  float t=T*.028;
  vec2 q=vec2(fbm(a+vec2(0.,t),2),fbm(a+vec2(5.2,1.3)-t,2));
  vec2 r=vec2(fbm(a+1.9*q+vec2(1.7,9.2)+t*1.4,2),fbm(a+1.9*q+vec2(8.3,2.8)-t*1.2,2));
  float f=fbm(a+2.6*r,${octaves});
  o=vec4(f+.5,length(q)*1.6,r.x+.5,1.);
}`;

const SHOW = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D F;
uniform vec2 S, fo, fp;                  // canvas size in css px; a mark point; where it sits on screen
uniform vec3 A, B, C, K;                 // palette; K: bar, stroke, glint
uniform float U, D, M, I, H, Y, N, G, W, Z;  // px per unit, dpr, mark, intensity, horizon, its height, day, grain, frame, zoom

const vec3 INK=vec3(.0196,.0196,.0235);
float q4(vec2 p,vec2 a,vec2 b,vec2 c,vec2 e){
  vec2 t[4]=vec2[](a,b,c,e); float d=dot(p-a,p-a),s=1.;
  for(int i=0,j=3;i<4;j=i,i++){
    vec2 k=t[j]-t[i],w=p-t[i],h=w-k*clamp(dot(w,k)/dot(k,k),0.,1.);
    d=min(d,dot(h,h));
    bvec3 c3=bvec3(p.y>=t[i].y,p.y<t[j].y,k.x*w.y>k.y*w.x);
    if(all(c3)||all(not(c3))) s=-s;
  }
  return s*sqrt(d);
}
vec3 glass(float d,vec3 lo,vec3 mi,vec3 hi){
  vec2 n=normalize(vec2(dFdx(d),dFdy(d))+1e-6);
  float l=smoothstep(-2.3,0.,d);
  vec4 t=texture(F,.5+(v-.5)*.86+n*l*l*l*vec2(.03*S.y/S.x,.03));    // the field, bent by the edge. Stays inside the texture
  float L=t.r*.72+t.b*.28+l*.05;
  vec3 c=mix(lo,mi,smoothstep(.4,.56,L));
  c=mix(c,hi,smoothstep(.52,.7,L+.08*t.g));
  float i=min(d,0.);                                  // d is positive outside: never let exp() run away there
  return c*(.84+.3*l)+hi*exp(i*5.)*.3+vec3(1.)*exp(i*24.)*.55;
}
void main(){
  vec4 t=texture(F,v);
  float f=t.r,q=t.g,r=t.b;
  float rib=smoothstep(.56,.8,f), sheet=smoothstep(.2,.9,q)*smoothstep(.5,.7,f);
  float vig=1.-smoothstep(.3,1.05,length((v-vec2(.62,.5))*vec2(1.25,1.)));
  vec3 col=INK+I*mix(.5,1.,vig)*(A*(.5*rib+.26*sheet)+B*rib*rib*.3+C*pow(rib,5.)*.12);

  if(H>.001){                                                     // dawn: a planet's edge, the sun just behind it
    float a=S.x/S.y; vec2 c=vec2((v.x-.5)*a,v.y);
    float e=length(c-vec2(0.,Y-3.4))-3.4+(f-.5)*.014;
    float sky=max(e,0.), spot=.5+.5*exp(-c.x*c.x*1.4);
    float g=spot*H;                                               // mixed, not added: gold has to stay gold
    col+=vec3(.14,.33,1.)*exp(-sky*3.2)*.5*g;
    col=mix(col,vec3(.62,.9,.2),exp(-sky*13.)*.62*g);
    col=mix(col,vec3(1.,.76,.26),exp(-sky*85.)*.96*g);
    col=mix(col,INK*.7+vec3(.01,.014,.03)*H,(1.-smoothstep(-.0012,.0012,e))*H);
  }
  if(N>.001){                                                     // day: paper, with pastel lime and blue drifting
    vec3 d=vec3(.953,.953,.961);
    d=mix(d,vec3(.86,.96,.62),smoothstep(.46,.78,f)*.62);
    d=mix(d,vec3(.72,.81,1.),smoothstep(.42,.74,r)*.5);
    col=mix(col,d,N);
  }
  if(M>.001){
    vec2 m=fo+(vec2(v.x,1.-v.y)*S-fp)/U;
    float e=1./(U*D);
    float db=q4(m+vec2((1.-K.x)*12.1,0.),vec2(9.45,7.25),vec2(25.75,7.25),vec2(22.53,12.45),vec2(6.23,12.45));
    float ds=K.y<.002?30.:max(q4(m,vec2(17.11,12.15),vec2(22.71,12.15),vec2(14.9,24.75),vec2(9.3,24.75)),m.y-mix(12.,25.,K.y));
    float gb=max(db,0.),gs=max(ds,0.),ab=K.x*M;
    col+=(vec3(.2,.38,1.)*(exp(-gb*1.15)*.3+exp(-gb*.36)*.17)*ab+vec3(.62,.92,.16)*(exp(-gs*1.1)*.24+exp(-gs*.34)*.12)*M)/Z;
    float k=smoothstep(11.5,25.,m.y);
    vec3 cs=glass(ds,mix(vec3(.36,.56,.04),vec3(.04,.2,.05),k),mix(vec3(.776,.957,.196),vec3(.2,.55,.1),k),mix(vec3(.91,1.,.48),vec3(.6,.9,.18),k));
    cs*=1.-.62*exp(-gb*2.2);                                      // the bar's shadow on the stroke
    float ins=1.-smoothstep(-e,e,ds),inb=1.-smoothstep(-e,e,db);
    col=mix(col,cs,ins*M);
    float lx=smoothstep(7.,21.,m.x);
    vec3 cb=glass(db,vec3(.05,.1,.42),mix(vec3(.1,.22,.68),vec3(.24,.45,1.),lx),mix(vec3(.2,.36,.86),vec3(.525,.65,1.),lx));
    col=mix(col,cb,inb*ab);
    float s=m.x+.62*m.y,g=exp(-pow((s-K.z)/1.25,2.))*.8+exp(-pow((s-K.z+2.6)/.34,2.))*.45;
    col+=g*max(inb*K.x,ins)*M;
  }
  float ign=fract(52.9829189*fract(dot(gl_FragCoord.xy+5.588238*W,vec2(.06711056,.00583715))));
  o=vec4(col+(ign-.5)*(2.2/255.)+(ign-.5)*G,1.);
}`;

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const pal = (a: string, b: string, c: string) => [...rgb(a), ...rgb(b), ...rgb(c)];

const MOODS: Record<Mood, { pal: number[]; intensity: number; horizon: number; day: number }> = {
  night: { pal: pal('#0E2A86', '#2F66FF', '#86A6FF'), intensity: .62, horizon: 0, day: 0 },
  alert: { pal: pal('#3C140C', '#9C4228', '#D59A4A'), intensity: .78, horizon: 0, day: 0 },
  safe: { pal: pal('#0B3417', '#3E9A2C', '#C6F432'), intensity: .82, horizon: 0, day: 0 },
  deep: { pal: pal('#070C22', '#0D1A48', '#233A8C'), intensity: .5, horizon: 0, day: 0 },
  dawn: { pal: pal('#0C2474', '#2558E0', '#86A6FF'), intensity: .7, horizon: 1, day: 0 },
  day: { pal: pal('#000000', '#000000', '#000000'), intensity: 0, horizon: 0, day: 1 },
};

// Everything GSAP drives. The page's scripts tween these numbers; the loop just reads them.
export const u = {
  pal: [...MOODS.night.pal], intensity: 0, horizon: 0, horizonY: .03, day: 0,
  sun: 1,                       // scroll's share of the horizon: 0 once it has set, so it never crosses content
  mark: 0, bar: 0, stroke: 0, glint: -5,
  zoom: 1,                      // 1 -> 40
  shift: 0,                     // 0 at rest, 1 once the focus has drifted to screen centre
  fieldZoom: 1,
  pause: false, covered: false,
};

export const moodOf = (m: Mood) => MOODS[m];

let frame: (now: number) => void = () => {};
let resize: () => void = () => {};
let still = false;

export const renderOnce = () => frame(performance.now());

// Where the 7 rests: right of centre and slightly off the bottom on a desktop, centred above the text on a phone.
function rest(w: number, h: number) {
  const unit = w >= 900 ? h * .85 / 17.5 : Math.min(h * .25 / 17.5, w * .56 / 19.52);
  const left = w >= 900 ? w * 1.03 - 19.52 * unit : (w - 19.52 * unit) / 2;
  const top = w >= 900 ? h * 1.04 - 17.5 * unit : h * .085;
  return { unit, x: left - 6.23 * unit, y: top - 7.25 * unit };
}

export function startShader(canvas: HTMLCanvasElement, opts: { still: boolean }) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) return false;
  still = opts.still;
  const coarse = matchMedia('(pointer: coarse)').matches;

  const compile = (fsrc: string) => {
    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, fsrc]] as const) {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(prog, s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    }
    gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
    const loc: Record<string, WebGLUniformLocation> = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(prog, i)!.name; loc[name] = gl.getUniformLocation(prog, name)!; }
    return { prog, loc };
  };
  const field = compile(FIELD(coarse ? 2 : 3));
  const show = compile(SHOW);
  if (!gl.getProgramParameter(field.prog, gl.LINK_STATUS) || !gl.getProgramParameter(show.prog, gl.LINK_STATUS)) return false;

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // RGB10_A2 keeps the small field from banding and needs no extension.
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  let cssW = 1, cssH = 1, dpr = 1, fw = 1, fh = 1, quality = 1;
  resize = () => {
    cssW = canvas.clientWidth || innerWidth; cssH = canvas.clientHeight || innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 1.5) * quality;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    fw = Math.max(2, Math.round(cssW * .5 * quality)); fh = Math.max(2, Math.round(cssH * .5 * quality));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, fw, fh, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (still || u.pause) renderOnce();
  };

  // The pointer: a soft swirl in the field and 1-2% parallax on the 7. Eased here so GSAP's pause stops it too.
  const aim = { x: 0, y: 0, on: 0 }, cur = { x: 0, y: 0, on: 0 };
  if (!coarse && !still) addEventListener('pointermove', (e) => {
    aim.x = e.clientX / innerWidth - .5; aim.y = .5 - e.clientY / innerHeight; aim.on = 1;
  }, { passive: true });

  let time = 40 + Math.random() * 60, last = 0, frames = 0, slow = 0, tick = 0;
  frame = (now) => {
    const dt = Math.min(Math.max(now - last, 0) / 1000, .05); last = now;
    if (!still) time += dt;
    cur.x += (aim.x - cur.x) * .06; cur.y += (aim.y - cur.y) * .06;
    aim.on *= .985; cur.on += (aim.on - cur.on) * .05;

    // Two passes. First the field, small.
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, fw, fh);
    gl.useProgram(field.prog);
    gl.uniform2f(field.loc.R, fw, fh);
    gl.uniform1f(field.loc.T, time);
    gl.uniform1f(field.loc.Z, u.fieldZoom);
    gl.uniform3f(field.loc.P, cur.x * cssW / cssH, cur.y, cur.on * .32);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Then everything else, at full size.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(show.prog);
    const r = rest(cssW, cssH), L = show.loc;
    const fx = r.x + FOCUS[0] * r.unit, fy = r.y + FOCUS[1] * r.unit;  // the focus point at rest
    const px = cur.x * cssW * .018, py = -cur.y * cssH * .018;
    gl.uniform2f(L.S, cssW, cssH);
    gl.uniform2f(L.fo, FOCUS[0], FOCUS[1]);
    gl.uniform2f(L.fp, fx + (cssW / 2 - fx) * u.shift + px, fy + (cssH / 2 - fy) * u.shift + py);
    gl.uniform1f(L.U, r.unit * u.zoom);
    gl.uniform1f(L.Z, u.zoom);
    gl.uniform1f(L.D, dpr);
    gl.uniform1f(L.M, u.mark);
    gl.uniform3f(L.K, u.bar, u.stroke, u.glint);
    gl.uniform3f(L.A, u.pal[0], u.pal[1], u.pal[2]);
    gl.uniform3f(L.B, u.pal[3], u.pal[4], u.pal[5]);
    gl.uniform3f(L.C, u.pal[6], u.pal[7], u.pal[8]);
    gl.uniform1f(L.I, u.intensity);
    gl.uniform1f(L.H, u.horizon * u.sun);
    gl.uniform1f(L.Y, u.horizonY);
    gl.uniform1f(L.N, u.day);
    gl.uniform1f(L.G, .006);
    gl.uniform1f(L.W, still ? 0 : (tick++ % 64));
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ponytail: quality only steps down, once per dip. A laptop on battery stays on the lower step until reload.
    if (!still && ++frames >= 45) {
      if (slow / frames > .5 && quality > .55) { quality *= .8; resize(); }
      frames = 0; slow = 0;
    }
    if (dt > .024) slow++;
  };

  new ResizeObserver(() => resize()).observe(canvas);
  resize();
  if (!still) last = performance.now();
  return true;
}

export const shaderTick = (now: number) => {
  if (still || u.pause || u.covered || document.hidden) return;
  frame(now);
};
