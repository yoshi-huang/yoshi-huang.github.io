(function () {
  'use strict';
  const scene = document.getElementById('connection-scene');
  const lanes = document.getElementById('packet-lanes');
  const title = document.getElementById('connection-title');
  const caption = document.getElementById('connection-caption');
  const status = document.getElementById('connection-status-text');
  const skip = document.getElementById('connection-skip');
  const reset = document.getElementById('btn-reset');
  const NS = 'http://www.w3.org/2000/svg';
  let runId = 0;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const steps = {
    handshake: [
      ['syn','SYN','用戶端提出連線請求'],
      ['synack','SYN + ACK','伺服器確認並回應'],
      ['ack','ACK','用戶端確認，連線建立'],
    ],
    teardown: [
      ['fin','FIN','用戶端請求結束連線'],
      ['finack','ACK','伺服器確認收到'],
      ['finack','FIN','伺服器請求結束連線'],
      ['ack','ACK','用戶端確認，連線關閉'],
    ],
  };
  const palette = {syn:'#3474c8',synack:'#3474c8',ack:'#19865f',fin:'#a27622',finack:'#a27622'};
  function svgEl(tag, attrs = {}) {
    const el = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key,value]) => el.setAttribute(key,value));
    return el;
  }
  function drawRows(sequence, mode) {
    lanes.replaceChildren();
    const svg = svgEl('svg',{class:'connection-diagram-svg',viewBox:'0 0 1000 760',role:'img','aria-label':'時間向下的 TCP 封包時序圖'});
    const defs = svgEl('defs');
    const marker = svgEl('marker',{id:'packet-arrowhead',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'8',markerHeight:'8',orient:'auto-start-reverse'});
    marker.appendChild(svgEl('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'context-stroke'}));
    defs.appendChild(marker); svg.appendChild(defs);
    svg.appendChild(svgEl('line',{class:'endpoint-life sender-life',x1:'120',y1:'55',x2:'120',y2:'725'}));
    svg.appendChild(svgEl('line',{class:'endpoint-life receiver-life',x1:'880',y1:'55',x2:'880',y2:'725'}));
    const sender = svgEl('text',{class:'endpoint-name',x:'120',y:'35','text-anchor':'middle'}); sender.textContent='SENDER'; svg.appendChild(sender);
    const receiver = svgEl('text',{class:'endpoint-name',x:'880',y:'35','text-anchor':'middle'}); receiver.textContent='RECEIVER'; svg.appendChild(receiver);
    const yTop = mode === 'teardown' ? 125 : 150;
    const yGap = mode === 'teardown' ? 165 : 225;
    const movers = [];
    sequence.forEach(([kind,label],index) => {
      const reverse = mode === 'handshake' ? index === 1 : [1,2].includes(index);
      const y1 = yTop + index*yGap;
      const y2 = y1 + (mode === 'teardown' ? 95 : 110);
      const sx = reverse ? 880 : 120, ex = reverse ? 120 : 880;
      const path = svgEl('path',{class:`packet-arrow ${kind}`,d:`M ${sx} ${y1} L ${ex} ${y2}`,'marker-end':'url(#packet-arrowhead)',stroke:palette[kind]});
      path.style.setProperty('--packet-color',palette[kind]); svg.appendChild(path);
      const group = svgEl('g',{class:'packet-mover',transform:`translate(${sx} ${y1})`});
      group.appendChild(svgEl('rect',{class:`packet-label-box ${kind}`,x:'-72',y:'-25',width:'144',height:'50',rx:'12',stroke:palette[kind],fill:'#fff'}));
      const text = svgEl('text',{class:`packet-label-text ${kind}`,x:'0',y:'6','text-anchor':'middle',fill:palette[kind]}); text.textContent=label; group.appendChild(text);
      svg.appendChild(group);
      movers.push({group,sx,sy:y1,ex,ey:y2});
    });
    lanes.appendChild(svg);
    return movers;
  }
  async function movePacket(mover, thisRun) {
    const start = performance.now(), duration = 400;
    return new Promise(resolve => {
      function frame(now) {
        if (thisRun !== runId) return resolve(false);
        const p = Math.min(1,(now-start)/duration);
        const eased = 1-Math.pow(1-p,1.75);
        const x=mover.sx+(mover.ex-mover.sx)*eased;
        const y=mover.sy+(mover.ey-mover.sy)*eased;
        mover.group.setAttribute('transform',`translate(${x} ${y})`);
        if(p<1) requestAnimationFrame(frame); else resolve(true);
      }
      requestAnimationFrame(frame);
    });
  }
  function finish() {
    runId++;
    scene.classList.add('leaving');
    document.body.classList.remove('connection-intro');
    document.body.classList.add('connection-revealing');
    status.textContent = '連線已就緒';
    setTimeout(() => {
      scene.hidden=true;
      scene.classList.remove('leaving','complete','phase-switch','phase-enter');
      document.body.classList.remove('connection-revealing');
    },820);
  }
  async function play(mode) {
    const thisRun=++runId;
    document.body.classList.add('connection-presented');
    document.body.classList.add('connection-intro');
    scene.hidden=false; scene.classList.remove('leaving','complete','entering');
    if(mode==='reconnect') {
      document.body.classList.add('connection-returning');
      scene.classList.add('entering');
      requestAnimationFrame(()=>requestAnimationFrame(()=>document.body.classList.remove('connection-returning')));
      setTimeout(()=>scene.classList.remove('entering'),520);
    }
    const playPhase=async (phase,heading,subheading,messages) => {
      scene.dataset.phase=phase;
      title.textContent=heading; caption.textContent=subheading;
      status.textContent=phase==='teardown' ? '依序關閉連線...' : '交換控制封包，完成連線建立';
      const movers=drawRows(steps[phase],phase);
      for(let i=0;i<messages.length;i++) {
        if(thisRun!==runId) return false;
        if(!await movePacket(movers[i],thisRun)) return false;
      }
      status.textContent=phase==='teardown' ? '連線已關閉' : 'TCP 連線已建立';
      return true;
    };
    if(mode==='handshake') {
      await playPhase('handshake','建立連線','TCP 三次握手',['傳送 SYN，請求連線','收到 SYN + ACK，伺服器已準備好','傳送 ACK，TCP 連線建立']);
    } else {
      if(!await playPhase('teardown','關閉連線','TCP 四次揮手',['傳送 FIN，開始關閉連線','收到 ACK，伺服器確認收到','收到 FIN，伺服器請求關閉','傳送 ACK，連線已關閉'])) return;
      if(thisRun!==runId) return;
      scene.classList.add('phase-switch');
      await wait(320);
      if(thisRun!==runId) return;
      scene.classList.remove('phase-switch');
      scene.classList.add('phase-enter');
      await playPhase('handshake','建立連線','TCP 三次握手',['傳送 SYN，請求連線','收到 SYN + ACK，伺服器已準備好','傳送 ACK，新 TCP 連線建立']);
      scene.classList.remove('phase-enter');
    }
    if(thisRun===runId){scene.classList.add('complete');finish();}
  }
  skip.addEventListener('click',finish);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!scene.hidden)finish();});
  reset.addEventListener('click',()=>setTimeout(()=>play('reconnect'),0),true);
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>play('handshake'),{once:true});
  else play('handshake');
})();
