// The site's shader, driven frame by frame. Same GLSL as website/src/scripts/shader.ts; only the clock and the
// placement of the 7 changed, so a frame depends on nothing but its time.
(() => {
  const { VERT, FIELD, SHOW } = window.GLSL;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const pal = (a, b, c) => [...rgb(a), ...rgb(b), ...rgb(c)];
  const MOODS = {
    night: { pal: pal('#0E2A86', '#2F66FF', '#86A6FF'), intensity: .62, horizon: 0, day: 0 },
    alert: { pal: pal('#3C140C', '#9C4228', '#D59A4A'), intensity: .78, horizon: 0, day: 0 },
    safe: { pal: pal('#0B3417', '#3E9A2C', '#C6F432'), intensity: .82, horizon: 0, day: 0 },
    deep: { pal: pal('#070C22', '#0D1A48', '#233A8C'), intensity: .5, horizon: 0, day: 0 },
    dawn: { pal: pal('#0C2474', '#2558E0', '#86A6FF'), intensity: .7, horizon: 1, day: 0 },
    day: { pal: pal('#000000', '#000000', '#000000'), intensity: 0, horizon: 0, day: 1 },
  };
  // Everything the timeline drives. fx,fy: a point on the mark. sx,sy: where that point sits on screen. unit: px per unit.
  const u = { pal: [...MOODS.alert.pal], intensity: 0, horizon: 0, horizonY: .03, day: 0, mark: 0, bar: 0, stroke: 0, glint: -5,
    zoom: 1, fx: 16, fy: 16, sx: 960, sy: 540, unit: 34, fieldZoom: 1, swirl: 0 };

  function start(canvas, dpr) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no webgl2');
    const compile = (src) => {
      const prog = gl.createProgram();
      for (const [type, s] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, src]]) {
        const sh = gl.createShader(type); gl.shaderSource(sh, s); gl.compileShader(sh); gl.attachShader(prog, sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      }
      gl.bindAttribLocation(prog, 0, 'p'); gl.linkProgram(prog);
      const loc = {}; const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(prog, i).name; loc[name] = gl.getUniformLocation(prog, name); }
      return { prog, loc };
    };
    const field = compile(FIELD(3)), show = compile(SHOW);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const W = 1920, H = 1080; canvas.width = W * dpr; canvas.height = H * dpr;
    const fw = W, fh = H;                                       // twice the site's field size: this is a big screen
    const tex = gl.createTexture(), fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB10_A2, fw, fh, 0, gl.RGBA, gl.UNSIGNED_INT_2_10_10_10_REV, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT], [gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    return (t, frame) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, fw, fh); gl.useProgram(field.prog);
      gl.uniform2f(field.loc.R, fw, fh); gl.uniform1f(field.loc.T, 60 + t * 5); gl.uniform1f(field.loc.Z, u.fieldZoom);
      gl.uniform3f(field.loc.P, 0, 0, u.swirl); gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height); gl.useProgram(show.prog);
      const L = show.loc;
      gl.uniform2f(L.S, W, H); gl.uniform2f(L.fo, u.fx, u.fy); gl.uniform2f(L.fp, u.sx, u.sy);
      gl.uniform1f(L.U, u.unit * u.zoom); gl.uniform1f(L.Z, u.zoom); gl.uniform1f(L.D, dpr); gl.uniform1f(L.M, u.mark);
      gl.uniform3f(L.K, u.bar, u.stroke, u.glint);
      gl.uniform3f(L.A, u.pal[0], u.pal[1], u.pal[2]); gl.uniform3f(L.B, u.pal[3], u.pal[4], u.pal[5]); gl.uniform3f(L.C, u.pal[6], u.pal[7], u.pal[8]);
      gl.uniform1f(L.I, u.intensity); gl.uniform1f(L.H, u.horizon); gl.uniform1f(L.Y, u.horizonY); gl.uniform1f(L.N, u.day);
      gl.uniform1f(L.G, .006); gl.uniform1f(L.W, frame % 64);
      gl.drawArrays(gl.TRIANGLES, 0, 3); gl.finish();
    };
  }
  window.Shader = { u, MOODS, start };
})();
