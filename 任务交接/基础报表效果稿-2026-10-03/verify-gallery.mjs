import {createRequire} from 'node:module';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
const directory=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(directory,'../../ai-data/apps/web/package.json'));
const {chromium,expect}=require('@playwright/test');
const pages=JSON.parse(await readFile(path.join(directory,'审核状态.json'),'utf8'));
const images=[];
for(const page of pages){
 const bytes=await readFile(path.join(directory,page.file));
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(width!==1672||height!==941)throw new Error('图片尺寸不一致: '+page.file);
 images.push({number:page.n,file:page.file,width,height,approved:page.approved});
}
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(pathToFileURL(path.join(directory,'审核.html')).href);
 await page.locator('img').evaluateAll(async elements=>{
  await Promise.all(elements.map(async image=>{image.loading='eager';await image.decode();}));
 });
 await expect(page.locator('article:visible')).toHaveCount(12);
 await page.getByRole('button',{name:'已认可 12',exact:true}).click();
 await expect(page.locator('article:visible')).toHaveCount(12);
 await page.getByRole('button',{name:'待审核 0',exact:true}).click();
 await expect(page.locator('article:visible')).toHaveCount(0);
 await page.getByRole('button',{name:'全部 12',exact:true}).click();
 await expect(page.locator('article:visible')).toHaveCount(12);
 const links=await page.locator('a').evaluateAll(elements=>elements.map(a=>a.href));
 for(const link of links)await stat(fileURLToPath(link));
 if(errors.length)throw new Error(errors.join('\n'));
 const result={images,approved:12,pending:0,checked_links:links.length,filters:'passed',errors};
 await writeFile(path.join(directory,'目录检查.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify({images:images.length,approved:12,pending:0,links:links.length,errors}));
}finally{await browser.close();}

