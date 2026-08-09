import fs from "node:fs";
const cfg = JSON.parse(fs.readFileSync(".syscora/config.json","utf8")).model;
const schema = {
  type:"object",
  required:["normalizedGoal","category","entities","successCriteria"],
  properties:{
    normalizedGoal:{type:"string"},
    category:{type:"string",enum:["SYSTEM","PROJECT","APPLICATION","BROWSER","DEVELOPER","ENVIRONMENT","CONVERSATION"]},
    directAnswer:{type:"string"},
    answerableWithoutInspecting:{type:"boolean"},
    entities:{type:"object"},
    successCriteria:{type:"array",items:{type:"string"}},
    requiredCapabilities:{type:"array",items:{type:"string"}}
  }
};
const r = await fetch(cfg.baseUrl+"/chat/completions",{
  method:"POST",
  headers:{"Content-Type":"application/json",Authorization:"Bearer "+cfg.apiKey},
  body:JSON.stringify({
    model:cfg.model,
    messages:[{role:"user",content:"Classify this request. If it is a greeting needing nothing from the computer, category=CONVERSATION and directAnswer=your friendly reply.\n<request>hi</request>"}],
    response_format:{type:"json_schema",json_schema:{name:"schema",schema,strict:true}},
    temperature:0.3
  })
});
const j = await r.json();
console.log("HTTP", r.status);
console.log(JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0,900));
