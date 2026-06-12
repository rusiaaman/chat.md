document.addEventListener('DOMContentLoaded',()=>{
  initLoader();
  initCursor();
  initLenis();
  initHeroCanvas();
  initAnimations();
  initTilt();
  initMagnetic();
  initScrollVelocity();
});

function initLoader(){
  const loader=document.querySelector('.loader');
  if(!loader)return;
  window.addEventListener('load',()=>{
    setTimeout(()=>loader.classList.add('done'),600);
  });
}

function initCursor(){
  if(window.matchMedia('(pointer:coarse)').matches)return;
  const cursor=document.querySelector('.cursor');
  let x=0,y=0,mx=0,my=0;
  window.addEventListener('mousemove',e=>{
    x=e.clientX;y=e.clientY;
  },{passive:true});
  const interactives='a,button,[data-hover],.product-card';
  document.addEventListener('mouseover',e=>{
    if(e.target.closest(interactives))cursor.classList.add('hover');
  });
  document.addEventListener('mouseout',e=>{
    if(e.target.closest(interactives))cursor.classList.remove('hover');
  });
  function loop(){
    mx+=(x-mx)*.15;my+=(y-my)*.15;
    cursor.style.transform=`translate(${mx}px,${my}px) translate(-50%,-50%)`;
    requestAnimationFrame(loop);
  }
  loop();
}

function initLenis(){
  const lenis=new Lenis({duration:1.2,easing:t=>Math.min(1,1.001-Math.pow(2,-10*t))});
  function raf(time){lenis.raf(time);requestAnimationFrame(raf)}
  requestAnimationFrame(raf);
  lenis.on('scroll',ScrollTrigger.update);
  gsap.ticker.add(time=>lenis.raf(time*1000));
  gsap.ticker.lagSmoothing(0);
}

function initHeroCanvas(){
  const canvas=document.getElementById('hero-canvas');
  if(!canvas)return;
  const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true});
  renderer.setSize(window.innerWidth,window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(60,window.innerWidth/window.innerHeight,.1,100);
  camera.position.z=5;
  const geometry=new THREE.PlaneGeometry(18,12,40,40);
  const material=new THREE.ShaderMaterial({
    uniforms:{
      uTime:{value:0},
      uColor1:{value:new THREE.Color('#f8f6f2')},
      uColor2:{value:new THREE.Color('#e8e2da')},
      uColor3:{value:new THREE.Color('#d9774d')},
      uMouse:{value:new THREE.Vector2(.5,.5)}
    },
    vertexShader:`
      varying vec2 vUv;
      uniform float uTime;
      void main(){
        vUv=uv;
        vec3 pos=position;
        float wave=sin(pos.x*2.0+uTime)*0.12+sin(pos.y*1.5+uTime*0.8)*0.12;
        pos.z+=wave;
        gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);
      }
    `,
    fragmentShader:`
      varying vec2 vUv;
      uniform float uTime;
      uniform vec3 uColor1,uColor2,uColor3;
      uniform vec2 uMouse;
      void main(){
        float n=sin(vUv.x*6.0+uTime*0.4)*sin(vUv.y*6.0+uTime*0.35)*0.5+0.5;
        float mouse=smoothstep(0.5,0.0,distance(vUv,uMouse));
        vec3 col=mix(uColor1,uColor2,n);
        col=mix(col,uColor3,mouse*0.12);
        gl_FragColor=vec4(col,1.0);
      }
    `
  });
  const mesh=new THREE.Mesh(geometry,material);
  scene.add(mesh);
  let mx=.5,my=.5;
  window.addEventListener('mousemove',e=>{
    mx=e.clientX/window.innerWidth;my=e.clientY/window.innerHeight;
  },{passive:true});
  function animate(time){
    material.uniforms.uTime.value=time*.0004;
    material.uniforms.uMouse.value.x+=(mx-material.uniforms.uMouse.value.x)*.04;
    material.uniforms.uMouse.value.y+=(my-material.uniforms.uMouse.value.y)*.04;
    renderer.render(scene,camera);
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  window.addEventListener('resize',()=>{
    camera.aspect=window.innerWidth/window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth,window.innerHeight);
  });
}

function initAnimations(){
  gsap.registerPlugin(ScrollTrigger);
  const heroTl=gsap.timeline({defaults:{ease:'power3.out'}});
  heroTl.from('.hero-title .char',{y:120,opacity:0,rotateX:90,stagger:.03,duration:1.2})
    .from('.hero-content .eyebrow,.hero-sub,.hero-actions',{y:30,opacity:0,stagger:.12},'-=.8')
    .from('.hero-img',{y:80,opacity:0,scale:.9,stagger:.15,duration:1.2},'-=1')
    .from('.nav',{y:-40,opacity:0,duration:.8},'-=1.2');

  gsap.utils.toArray('.hero-img').forEach(img=>{
    gsap.to(img,{
      yPercent:img.dataset.speed?-img.dataset.speed*350:-20,
      ease:'none',
      scrollTrigger:{trigger:'.hero',start:'top top',end:'bottom top',scrub:true}
    });
  });

  gsap.to('.hero-content',{
    yPercent:-15,opacity:0,
    ease:'none',
    scrollTrigger:{trigger:'.hero',start:'top top',end:'50% top',scrub:true}
  });

  gsap.from('.about-img',{clipPath:'inset(0 100% 0 0)',duration:1.4,ease:'power3.inOut',
    scrollTrigger:{trigger:'.about',start:'top 75%'}});
  gsap.from('.about-text > *',{y:40,opacity:0,stagger:.12,duration:1,ease:'power3.out',
    scrollTrigger:{trigger:'.about-text',start:'top 75%'}});

  gsap.from('.product-card',{y:60,opacity:0,stagger:.15,duration:.9,ease:'power3.out',
    scrollTrigger:{trigger:'.product-grid',start:'top 80%'}});

  gsap.utils.toArray('[data-reveal]').forEach((el,i)=>{
    gsap.from(el,{y:50,opacity:0,duration:.9,delay:i*.1,ease:'power3.out',
      scrollTrigger:{trigger:el,start:'top 85%'}});
  });

  gsap.from('.story-img',{x:-60,opacity:0,duration:1.2,ease:'power3.out',
    scrollTrigger:{trigger:'.story-card',start:'top 75%'}});
  gsap.from('.story-content > *',{y:40,opacity:0,stagger:.12,duration:1,ease:'power3.out',
    scrollTrigger:{trigger:'.story-content',start:'top 75%'}});

  gsap.from('.newsletter-inner > *',{y:40,opacity:0,stagger:.12,duration:1,ease:'power3.out',
    scrollTrigger:{trigger:'.newsletter',start:'top 75%'}});

  SplitText();
}

function SplitText(){
  const title=document.querySelector('.hero-title.split');
  if(!title)return;
  const text=title.textContent;
  title.innerHTML='';
  text.split('').forEach(char=>{
    const span=document.createElement('span');
    span.className='char';
    span.style.display='inline-block';
    span.textContent=char===' '?'\u00A0':char;
    title.appendChild(span);
  });
}

function initTilt(){
  if(window.matchMedia('(pointer:coarse)').matches)return;
  document.querySelectorAll('[data-tilt]').forEach(card=>{
    card.addEventListener('mousemove',e=>{
      const rect=card.getBoundingClientRect();
      const x=(e.clientX-rect.left)/rect.width-.5;
      const y=(e.clientY-rect.top)/rect.height-.5;
      card.style.transform=`perspective(800px) rotateY(${x*14}deg) rotateX(${-y*14}deg) scale(1.02)`;
    });
    card.addEventListener('mouseleave',()=>{
      card.style.transform='perspective(800px) rotateY(0) rotateX(0) scale(1)';
    });
  });
}

function initMagnetic(){
  if(window.matchMedia('(pointer:coarse)').matches)return;
  document.querySelectorAll('.magnetic').forEach(el=>{
    el.addEventListener('mousemove',e=>{
      const rect=el.getBoundingClientRect();
      const x=e.clientX-rect.left-rect.width/2;
      const y=e.clientY-rect.top-rect.height/2;
      el.style.transform=`translate(${x*.25}px,${y*.25}px)`;
    });
    el.addEventListener('mouseleave',()=>el.style.transform='');
  });
}

function initScrollVelocity(){
  let last=0;
  const nav=document.querySelector('.nav');
  window.addEventListener('scroll',()=>{
    const now=window.scrollY;
    if(now>last && now>200)nav.style.transform='translateY(-100%)';
    else nav.style.transform='translateY(0)';
    last=now;
  },{passive:true});
}