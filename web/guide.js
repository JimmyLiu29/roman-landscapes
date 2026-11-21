const dialog=document.querySelector('#guide-dialog');
let opener;
for (const button of document.querySelectorAll('[data-guide]')) {
  button.addEventListener('click',()=>{
    opener=button;
    for (const article of dialog.querySelectorAll('article')) {
      article.hidden=article.id!=='guide-'+button.dataset.guide;
    }
    dialog.showModal();
    dialog.scrollTop=0;
  });
}
document.querySelector('#guide-close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('close',()=>opener?.focus({preventScroll:true}));
for (const link of dialog.querySelectorAll('nav a')) link.addEventListener('click',event=>{
  event.preventDefault();
  const heading=dialog.querySelector(link.hash);
  heading.focus({preventScroll:true});
  heading.scrollIntoView({block:'start'});
});
