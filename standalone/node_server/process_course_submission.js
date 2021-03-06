/**
 * Created by Dongwook on 11/2/2015.
 */

var fs = require('fs');
var env = require('./lib/env.js');
var spawn = require("child_process").spawn;
var crypto = require('crypto');
var mkdirp = require('mkdirp');
var Promise = require("promise");

var js_utils = require("./lib/js_utils.js");
var azure = require('./lib/azure');
var RedisClient = require('./lib/redis_client').RedisClient;
var R2D = require("./lib/r2d.js");

var INSTRUCTOR_EMAIL = 'testslate01@gmail.com';

var getSaltedSha1 = function(email){
    var shasum = crypto.createHash('sha1');
    shasum.update(email+env.sha1_salt.netid);
    return shasum.digest('hex').toLowerCase();
};

var downloader = (function(){
    var pub = {};

    pub.run = function(course_id, submission_id, data){
        var azure_course_id = course_id.replace('_', '-');
        var pdf_filename = submission_id + '.pdf';
        var key = getSaltedSha1(data.email);
        var netid = data.email.split('@')[0];
        var dir_path = 'cache/' + azure_course_id + '/' + submission_id + '/' + netid;
        var full_path = '../' + dir_path + '/' + pdf_filename;

        return new Promise(function(resolve, reject) { // donwload
            if(data.status === 'Submitted'){
                console.log('+submitted:', data.email, azure_course_id, netid+'/'+pdf_filename);
                var skip_pdf_download = false;
                if(skip_pdf_download){
                    resolve(true);
                    return;
                }
                mkdirp('../' + dir_path);
                azure.BlobFileDownload(azure_course_id, key+'/'+pdf_filename, full_path, function (err) {
                    if (err) {
                        reject(err)
                    }
                    else {
                        resolve(true);
                    }
                });
            }
            else{
                console.log('-notsubmitted:', data.email);
                resolve(false);
            }
        });
    };

    return pub;
}());

var pdf_processor = (function(){
    var pub = {};


    var RGNS = {
        HEAD:0,
        LEFT:1,
        RGHT:2,
        FOOT:3
    };

    pub.run = function(course_id, submission_id, subs){
        var azure_course_id = course_id.replace('_', '-');
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;

        return js_utils.listFolder('../' + dir_path_submission).then(
            function(l){
                var promises = l.dirs.map(
                    function(dir_netid){
                        return function(){
                            return run_single_submission(
                                course_id,
                                submission_id,
                                dir_netid
                            );
                        }
                    }
                );

                return js_utils.serialPromiseFuncs(promises).then(
                    function(results){
                        console.log(results);
                        return null;
                    }
                );
            }
        );
    };

    var run_single_submission = function(course_id, submission_id, netid){
        var azure_course_id = course_id.replace('_', '-');
        var pdf_filename = submission_id + '.pdf';
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;
        var dir_path = dir_path_submission + '/' + netid;

        return runPythonProcess('../../node_server/' + dir_path, pdf_filename).then(
            function(python_output){
                return new Promise(function(resolve, reject){
                    if(python_output === null){return;}
                    var pcs_data = parsePcsData(python_output);

                    var err_catch = false;
                    for(var i = 0; i < pcs_data.length; ++i){
                        if(pcs_data[i].hasOwnProperty('error')){
                            err_catch = true;
                        }
                    }

                    if(err_catch){
                        console.log(
                            'failed:' + netid + ', '+pcs_data.map(function(pcs_page){return pcs_page.error;})
                        );
                        resolve(false);
                    }
                    else{
                        console.log(
                            'succeed:' + netid + ', '+pcs_data.map(function(pcs_page){return pcs_page.split_pts.length;})
                        );
                        var output = constructVsDoc(pcs_data);
                        var fs = require('fs');
                        fs.writeFile('../' + dir_path + '/doc.vs_doc', JSON.stringify(output), function(err) {
                            if(err) {
                                resolve(false);
                                return console.log(err);
                            }
                            else{
                                resolve(true);
                            }
                        });
                    }
                });
            }
        );
    };

    var runPythonProcess = function(path, pdf){
        return new Promise(function(resolve, reject){
            var python_process = spawn('python',["../../django_server/lined_notebook/from_pdf.py", path, pdf]);

            var output = '';
            python_process.stdout.on('data', function(data){
                output += data;
            });
            python_process.stderr.on('data', function (data) {
                //console.error('python_process stderr:', data);
            });
            python_process.on('close', function(code){
                resolve(output);
            });
            python_process.on('error', function (err) {
                console.error('python_process error:'+err);
                reject(err);
            });
        });
    };

    var constructVsDocPage = function(w, h, splits){
        var round2 = function(x){
            return Math.round(x * 100.0) / 100.0;
        };

        var margin = w*0.05;

        var page = {};
        page.bbox = [0, 0, w, h];
        page.rgns = [
            {
                ttX: round2(margin),
                ttW: round2(w-2*margin)
            },
            {
                ttX: 0.0,
                ttW: 0.5
            },
            {
                ttX: 0.0,
                ttW: 0.5
            },
            {
                ttX: round2(margin),
                ttW: round2(w-2*margin)
            }
        ];
        page.rgns[RGNS.HEAD].rects = [];
        var top_split = 0;
        splits.forEach(function(split){
            page.rgns[RGNS.HEAD].rects.push(
                [0, top_split, w, split]
            );
            top_split = split;
        });
        page.rgns[RGNS.HEAD].rects.push(
            [0, top_split, w, h]
        );
        page.rgns[RGNS.LEFT].rects = [
            [0, h, 0.5*w, h]
        ];
        page.rgns[RGNS.RGHT].rects = [
            [0.5*w, h, w, h]
        ];
        page.rgns[RGNS.FOOT].rects = [
            [0, h, w, h]
        ];
        for(var r = 0; r < 4; ++r){
            for(var p = 0, l = page.rgns[r].rects.length; p < l; ++p){
                for(var i = 0; i < 4; ++i) {
                    page.rgns[r].rects[p][i] = round2(page.rgns[r].rects[p][i]);
                }
            }
        }

        return page;
    };

    var parsePcsData = function(data){
        data = data.split('<page>');
        var pcs_pages = [];
        data.forEach(function(datum){
            if ( datum.slice(-9, -2) === '</page>' || datum.slice(-8, -1) === '</page>'){
                pcs_pages.push(datum.slice(0, -9));
            }
        });

        for(var i = 0, l = pcs_pages.length; i < l; ++i){
            pcs_pages[i] = JSON.parse(pcs_pages[i].replace(/'/g, '"'));
        }
        return pcs_pages;
    };

    var constructVsDoc = function(pcs_pages){
        var vs_doc = {};
        vs_doc.ver = 6;
        vs_doc.pages = [];

        for(var i = 0, l = pcs_pages.length; i < l; ++i){
            vs_doc.pages.push(constructVsDocPage(pcs_pages[i].w, pcs_pages[i].h, pcs_pages[i].split_pts));
        }

        return vs_doc
    };

    return pub;
}());

var uploader = (function(){
    var pub = {};

    pub.Mode = {
        UploadPdfToR2Repo: 0,
        UploadPdfToCrsRepo: 1,
        CreateCrsGroups: 2
    };

    pub.run = function(course_id, submission_id, subs, mode){
        var azure_course_id = course_id.replace('_', '-');
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;

        return js_utils.listFolder('../' + dir_path_submission).then(
            function(l){
                return l.dirs; // dirs have net_id like names
            }
        ).then(
            function(net_ids){
                var to_proceed = true;
                var students = [];
                net_ids.map(function(net_id){
                    var found_in_subs = false;

                    for(var i = 0, l = subs.length; i < l; ++i){
                        if(subs[i].email===net_id+'@cornell.edu'){
                            students.push({id:net_id, email:net_id+'@cornell.edu'});
                            found_in_subs = true;
                        }
                        else if(subs[i].email===net_id+'@gmail.com'){
                            students.push({id:net_id, email:net_id+'@gmail.com'});
                            found_in_subs = true;
                        }
                    }
                    if(!found_in_subs){
                        to_proceed = false;
                        console.log(net_id + 'in the directory is not in the subs list');
                    }
                    else{
                        console.log('pass:'+net_id);
                    }
                });
                if(!to_proceed){
                    throw 'Some user(s) in the directory not found from the subs list';
                }
                return students;
            }
        ).then(
            function(students){ // upload
                var promises = students.map(function(student){
                    return function(){
                        if(mode === pub.Mode.UploadPdfToR2Repo){
                            return uploadPdfToR2Repo(course_id, submission_id, student);
                        }
                        else if(mode === pub.Mode.UploadPdfToCrsRepo){
                            return uploadPdfToCrsRepo(course_id, submission_id, student);
                        }
                        else if(mode === pub.Mode.CreateCrsGroups){
                            return createCrsGroup(course_id, submission_id, student);
                        }

                    };
                });
                return js_utils.serialPromiseFuncs(promises);
            }
        );
    };


    var uploadPdfToR2Repo = function(course_id, submission_id, student){
        var azure_course_id = course_id.replace('_', '-');
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;
        var dir_path = '../' + dir_path_submission + '/' + student.id;
        var pdf_hash = null;
        return uploadPdfDoc(dir_path).then(
            function(_pdf_hash){
                pdf_hash = _pdf_hash;
            }
        );
    };

    var uploadPdfToCrsRepo = function(course_id, submission_id, student){
        var key = getSaltedSha1(student.email);
        var azure_course_id = course_id.replace('_', '-');
        var pdf_filename = submission_id + '.pdf';
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;
        var dir_path = '../' + dir_path_submission + '/' + student.id;
        var stu_key = 'stu:'+course_id+'_'+student.email;

        // container
        return Promise.denodeify(azure.svc.createContainerIfNotExists.bind(azure.svc))(
            azure_course_id,
            { publicAccessLevel : 'blob' }
        ).then( // blob
            function(){
                return Promise.denodeify(azure.svc.createBlockBlobFromLocalFile.bind(azure.svc))(
                    azure_course_id,
                    key+'/'+pdf_filename,
                    dir_path + '/merged.pdf'
                )
            }
        ).then( // submission item
            function(){
                console.log('    uploaded:', azure.BLOB_HOST+azure_course_id+'/'+key+'/'+pdf_filename);
                return RedisClient.HGET(stu_key, 'submissions').then(
                    function(submissions){
                        submissions = JSON.parse(submissions);
                        submissions[submission_id].status = 'Submitted';
                        if(submissions[submission_id].submission_time === null){
                            submissions[submission_id].submission_time = submissions[submission_id].due
                        }
                        return submissions;
                    }
                ).then(
                    function(submissions){
                        return RedisClient.HSET(stu_key, 'submissions', JSON.stringify(submissions));
                    }
                );
            }
        );
    };

    var createCrsGroup = function(course_id, submission_id, student){
        var key = getSaltedSha1(student.email);
        var azure_course_id = course_id.replace('_', '-');
        var pdf_filename = submission_id + '.pdf';
        var dir_path_submission = 'cache/' + azure_course_id + '/' + submission_id;
        var dir_path = '../' + dir_path_submission + '/' + student.id;
        var stu_key = 'stu:'+course_id+'_'+student.email;

        return RedisClient.HGET(stu_key, 'submissions').then( // check that the PDF file is up on the course db
            function(submissions){
                submissions = JSON.parse(submissions);
                if(submissions[submission_id].status !== 'Submitted' && submissions[submission_id].status !== 'ReadyForReview'){
                    throw 'This user has no PDF file submitted yet:' + student.email + submission_id;
                }
                return null;
            }
        ).then(
            function(){
                return getFileSha1(dir_path+'/merged.pdf').then(
                    function(rtn){
                        pdf_hash = rtn;
                        return null;
                    }
                ).then(
                    function(){
                        return createCrsSubmissionDoc(
                            course_id,
                            submission_id,
                            student.email,
                            pdf_hash
                        );
                    }
                ).then(
                    function(group_data){ // update student submission data
                        return RedisClient.HGET('stu:'+course_id+'_'+student.email, 'submissions').then(
                            function(submissions){
                                submissions = JSON.parse(submissions);
                                submissions[submission_id].status = 'ReadyForReview';
                                submissions[submission_id].group = group_data;
                                return RedisClient.HSET('stu:'+course_id+'_'+student.email, 'submissions', JSON.stringify(submissions));
                            }
                        );
                    }
                );
            }
        );
    };

    var uploadPdfDoc = function(dir_path){ // upload merged.pdf and doc.vs_doc from the given dir_path
        var pdf_hash = '';
        return getFileSha1(dir_path+'/merged.pdf').then(
            function(rtn){
                pdf_hash = rtn;
            }
        ).then(
            function(){
                return Promise.denodeify(azure.svc.createContainerIfNotExists.bind(azure.svc))(
                    pdf_hash,
                    { publicAccessLevel : 'blob' }
                );
            }
        ).then(
            function(){ // upload the merged pdf
                return Promise.denodeify(azure.svc.createBlockBlobFromLocalFile.bind(azure.svc))(
                    pdf_hash,
                    'doc.pdf',
                    dir_path + '/merged.pdf'
                ).then(
                    function(rtn){
                        console.log('    uploaded:', azure.BLOB_HOST+pdf_hash+'/doc.pdf');
                    }
                );
            }
        ).then(
            function(){ // upload the metadata file
                return Promise.denodeify(azure.svc.createBlockBlobFromLocalFile.bind(azure.svc))(
                    pdf_hash,
                    'doc.vs_doc',
                    dir_path + '/doc.vs_doc'
                )
            }
        ).then(
            function(){
                return pdf_hash;
            }
        )
    };

    var getFileSha1 = function(path){
        return Promise.denodeify(fs.readFile)(path, "binary").then(
            function(pdf_str){
                var shasum = crypto.createHash('sha1');
                shasum.update(pdf_str);
                return shasum.digest('hex').toLowerCase();
            }
        );
    };

    var createCrsSubmissionDoc = function(course_id, subject_id, student_email, pdf_hash){
        var instructor_id = null;
        var manager_id = null;
        var doc_id = null;
        var group_id = null;

        var getManagerId = RedisClient.HGET(
            'email_user_lookup',
            'dy252@cornell.edu'
        );
        var getInstructorId = RedisClient.HGET(
            'email_user_lookup',
            INSTRUCTOR_EMAIL);

        return Promise.all([getInstructorId, getManagerId]).then( // get ids
            function(result){
                instructor_id = result[0];
                manager_id = result[1];
                return R2D.Doc.CreateNew( // create doc
                    manager_id.substring(4),
                    (new Date()).getTime(),
                    pdf_hash,
                    {course_id: course_id, subject_id: subject_id, student_email: student_email}
                )
            }
        ).then(
            function(_doc_id){ // create group
                doc_id = _doc_id;
                return R2D.Doc.AddNewGroup(manager_id.substring(4), doc_id);
            }
        ).then(
            function(_group_id){ // add instructor
                group_id = _group_id;
                return R2D.Group.connectUserAndGroup(group_id.substring(4), instructor_id.substring(4));
            }
        ).then(
            function(){ // set doc name
                var course_title = null;
                return RedisClient.HGET('crs:'+course_id, 'title').then(
                    function(_course_title){
                        course_title = _course_title;
                        return RedisClient.HGET('crs:'+course_id, 'submissions');
                    }
                ).then(
                    function(submissions){
                        submissions = JSON.parse(submissions);
                        return R2D.Doc.Rename(doc_id, course_title + ', ' + submissions[subject_id].title + ', '+ student_email);
                    }
                );
            }
        ).then( // set group name
            function(){
                return R2D.Group.Rename(group_id, 'Instructor\'s Feedback');
            }
        ).then(
            function(){
                return {
                    doc_id: doc_id,
                    group_id: group_id,
                    pdf_hash: pdf_hash
                };
            }
        );
    };

    return pub;
}());

exports.run = function(course_id, submission_id){

    RedisClient.HGET('crs:'+course_id, 'students').then(
        function(stus){
            var promises = JSON.parse(stus).map(function(stu){
                return RedisClient.HGET('stu:'+course_id+'_'+stu, 'submissions').then(
                    function(sub){
                        sub = JSON.parse(sub);
                        sub[submission_id].email = stu;
                        return sub[submission_id];
                    }
                );
            });
            return Promise.all(promises);
        }
    ).then(
        function(subs){
            var download = true; // download or upload
            var pdf_process = false;
            //var uploader_mode = uploader.Mode.UploadPdfToR2Repo;
            //var uploader_mode = uploader.Mode.UploadPdfToCrsRepo;
            var uploader_mode = uploader.Mode.CreateCrsGroups;
            if(download) { // download_and_process
                var promises = subs.map(function (sub) {
                    return function () {
                        return downloader.run(course_id, submission_id, sub);
                    }
                });
            }
            else if(pdf_process){
                var promises = [function(){return pdf_processor.run(course_id, submission_id, subs);}];
            }
            else{ // upload
                var promises = [function(){return uploader.run(course_id, submission_id, subs, uploader_mode);}];
            }
            return js_utils.serialPromiseFuncs(promises);
        }
    ).then(
        function(results){
            return RedisClient.end();
        }
    ).catch(
        function(err){
            console.error(err);
        }
    );
};
