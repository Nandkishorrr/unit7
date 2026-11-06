const FOCUS = [11.4, 15.6]; // the empty ink under the bar, left of the stroke: where the camera goes through
const VERT = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v=p*.5+.5; gl_Position=vec4(p,0.,1.); }`;

const FIELD = (octaves) => `#version 300 es
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
window.GLSL = { VERT, FIELD, SHOW, FOCUS };
