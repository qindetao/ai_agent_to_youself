from fastapi import FastAPI
from pydantic import BaseModel
app=FastAPI()

tb=[
    {"id":1,"user_name":"qin","password":"666"}
]
class User_create(BaseModel):
    user_name:str
    password:str
class User(User_create):
    id:int
class Response_model(BaseModel):
    msg:str
class Ai_work_output(BaseModel):
    content:str
@app.post("/users",response_model=Response_model)
def create_user(user:User_create):
    for m in tb:
        if(m["user_name"]==user.user_name):
            return{"msg":"账号已存在，请重新注册"}
    new_id= max(m["id"] for m in tb)+1
    new_user={
        "id":new_id,
        "user_name":user.user_name,
        "password":user.password
    }
    tb.append(new_user)
    return {"msg":"成功注册"}
@app.post("/log",response_model=Response_model)
def user_log(user:User_create):
    for m in tb:
        if m["user_name"]==user.user_name:
            if(m["password"]==user.password):
                return{"msg":"登录成功"}
            else:
                return{"msg":"密码错误"}
        else: 
            return {"msg":"账号不存在"}
@app.get("/index",response_model=Ai_work_output)
def get_ai_work_output():
    ai_work_output=666
    return {"content":ai_work_output}
